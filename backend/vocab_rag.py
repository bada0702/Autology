"""
Retrieval-augmented vocabulary extension.

Edges whose label is not in the core vocabulary (relation == "custom") are
matched against Wikidata's item-valued properties
(resources/wikidata_properties.json, built by scripts/build_wikidata_vocab.py):

1. Retrieve candidates with a hybrid score: character n-gram TF-IDF (works
   for Korean and English, no model needed) plus bge-m3 embeddings via Ollama
   when available.
2. A unique exact label/alias match links directly; otherwise an LLM picks a
   candidate or answers "none" — a wrong forced link is worse than no link.
   An LLM pick must also survive a second vote over the reversed option list
   and a check that the phrase is something a property can record.
3. A linked property is related to the core vocabulary:
   - equivalent (EQUIVALENTS table) → the edge is rewritten to the core relation;
   - subproperty (Wikidata P1647 chain reaches an equivalent) → the edge stays
     custom and records `super_relation`, so the reasoner applies prp-spo1;
   - Wikidata marks it transitive → the reasoner applies prp-trp to it.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import sys
from collections import Counter, deque
from functools import lru_cache
from typing import Any, Awaitable, Callable

import vocabulary as vocab

log = logging.getLogger("autology.vocab_rag")

RESOURCE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resources", "wikidata_properties.json")
# PyInstaller unpacks into a temp dir that is wiped on exit; keep the (slow to
# build) embedding cache next to the executable instead.
_APP_DIR = (os.path.dirname(sys.executable) if getattr(sys, "frozen", False)
            else os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(_APP_DIR, "data")
WIKIDATA = "http://www.wikidata.org/entity/"

EMBED_MODEL = os.getenv("AUTOLOGY_EMBED_MODEL", "bge-m3")
OLLAMA_BASE = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

# Wikidata property → (core relation, inverse?). "inverse" means the Wikidata
# direction is the reverse of the core relation (e.g. P527 has part).
EQUIVALENTS: dict[str, tuple[str, bool]] = {
    "P279": (vocab.SUBCLASS, False),
    "P31": (vocab.TYPE, False),
    "P361": ("part-of", False),
    "P527": ("part-of", True),
    "P749": ("part-of", False),      # parent organization
    "P355": ("part-of", True),       # has subsidiary
    "P463": ("member-of", False),
    "P102": ("member-of", False),    # member of political party
    "P54": ("member-of", False),     # member of sports team
    "P131": ("located-in", False),
    "P150": ("located-in", True),    # contains the administrative territorial entity
    "P276": ("located-in", False),
    "P706": ("located-in", False),   # located in/on physical feature
    "P1542": ("causes", False),
    "P828": ("causes", True),
    "P156": ("precedes", False),
    "P155": ("precedes", True),
    "P2283": ("uses", False),
    "P1535": ("uses", True),
    "P1056": ("produces", False),    # product or material produced
    "P176": ("produces", True),      # manufacturer
    "P170": ("produces", True),      # creator
    "P178": ("produces", True),      # developer
    "P800": ("produces", False),     # notable work
    "P1344": ("participates-in", False),
    "P710": ("participates-in", True),
    "P1547": ("depends-on", False),  # depends on software
    "P1552": ("has-property", False),  # has characteristic
}

BUILTINS = {vocab.SUBCLASS, vocab.TYPE}


# ── Dictionary ────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def load_properties() -> dict[str, dict]:
    with open(RESOURCE, encoding="utf-8") as f:
        data = json.load(f)
    return {p["id"]: p for p in data["properties"]}


def display_label(prop: dict, lang: str = "ko") -> str:
    labels = prop.get("label") or {}
    return labels.get(lang) or labels.get("en") or labels.get("ko") or prop["id"]


@lru_cache(maxsize=4096)
def core_mapping(pid: str) -> tuple[str, bool, bool] | None:
    """(core relation, inverse, exact) for a Wikidata property, or None.

    exact=True for the EQUIVALENTS table; otherwise the nearest ancestor in
    the P1647 (subproperty of) chain that is in the table.
    """
    if pid in EQUIVALENTS:
        rel, inv = EQUIVALENTS[pid]
        return rel, inv, True
    props = load_properties()
    seen = {pid}
    queue = deque((pid, s) for s in (props.get(pid) or {}).get("super", []))
    while queue:
        _, sup = queue.popleft()
        if sup in seen:
            continue
        seen.add(sup)
        if sup in EQUIVALENTS:
            rel, inv = EQUIVALENTS[sup]
            return rel, inv, False
        queue.extend((sup, s) for s in (props.get(sup) or {}).get("super", []))
    return None


# ── Retrieval ─────────────────────────────────────────────────────────────

def _norm(text: str) -> str:
    return re.sub(r"[\s_\-()]+", " ", str(text or "").lower()).strip()


def _grams(text: str) -> Counter:
    t = f" {_norm(text)} "
    out = Counter()
    for n in (2, 3):
        out.update(t[i:i + n] for i in range(len(t) - n + 1))
    return out


def _names(prop: dict) -> list[str]:
    names = list((prop.get("label") or {}).values())
    for lang in ("ko", "en"):
        names += (prop.get("aliases") or {}).get(lang, [])
    return names


class _LexicalIndex:
    """Character n-gram TF-IDF over names (weight 1.0) and descriptions (0.3)."""

    def __init__(self, props: dict[str, dict]):
        self.ids = list(props)
        docs = []
        for pid in self.ids:
            p = props[pid]
            g = Counter()
            for name in _names(p):
                g.update(_grams(name))
            for desc in (p.get("description") or {}).values():
                for k, v in _grams(desc).items():
                    g[k] += 0.3 * v
            docs.append(g)
        df = Counter()
        for d in docs:
            df.update(d.keys())
        n = len(docs)
        self.idf = {k: math.log((n + 1) / (v + 1)) + 1 for k, v in df.items()}
        self.vecs = [self._weigh(d) for d in docs]
        self.exact: dict[str, list[str]] = {}
        for pid in self.ids:
            for name in _names(props[pid]):
                self.exact.setdefault(_norm(name), []).append(pid)

    def _weigh(self, grams: Counter) -> dict[str, float]:
        vec = {k: (1 + math.log(v)) * self.idf.get(k, 1.0) for k, v in grams.items() if v > 0}
        norm = math.sqrt(sum(x * x for x in vec.values())) or 1.0
        return {k: x / norm for k, x in vec.items()}

    def scores(self, query: str) -> list[float]:
        q = self._weigh(_grams(query))
        return [sum(w * vec.get(k, 0.0) for k, w in q.items()) for vec in self.vecs]


@lru_cache(maxsize=1)
def _lexical() -> _LexicalIndex:
    return _LexicalIndex(load_properties())


class _EmbeddingIndex:
    """bge-m3 vectors for every property, cached on disk per dictionary build."""

    def __init__(self):
        self.matrix = None
        self.failed = False
        self._thread = None

    def warm_up(self) -> None:
        """Build/load the index in a background thread (first build ≈ minutes)."""
        import threading
        if self.matrix is not None or self.failed or (self._thread and self._thread.is_alive()):
            return
        self._thread = threading.Thread(target=self.ensure, name="vocab-embeddings", daemon=True)
        self._thread.start()

    @property
    def ready(self) -> bool:
        return self.matrix is not None

    def _cache_path(self) -> str:
        with open(RESOURCE, encoding="utf-8") as f:
            retrieved = json.load(f).get("retrieved", "unknown")
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", EMBED_MODEL)
        return os.path.join(CACHE_DIR, f"wikidata_props_{safe}_{retrieved}.npy")

    @staticmethod
    def _embed(texts: list[str]):
        import httpx
        import numpy as np
        r = httpx.post(f"{OLLAMA_BASE}/api/embed",
                       json={"model": EMBED_MODEL, "input": texts}, timeout=300)
        r.raise_for_status()
        m = np.asarray(r.json()["embeddings"], dtype="float32")
        return m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-9)

    def ensure(self) -> bool:
        if self.matrix is not None:
            return True
        if self.failed:
            return False
        try:
            import numpy as np
            path = self._cache_path()
            if os.path.exists(path):
                self.matrix = np.load(path)
                return True
            props = load_properties()
            texts = []
            for pid in _lexical().ids:
                p = props[pid]
                desc = (p.get("description") or {}).get("en") or (p.get("description") or {}).get("ko") or ""
                texts.append(" / ".join(_names(p)[:6]) + (f": {desc}" if desc else ""))
            parts = [self._embed(texts[i:i + 64]) for i in range(0, len(texts), 64)]
            self.matrix = np.vstack(parts)
            os.makedirs(CACHE_DIR, exist_ok=True)
            np.save(path, self.matrix)
            return True
        except Exception as exc:  # noqa: BLE001 — embeddings are optional
            log.info("embedding index unavailable, using lexical retrieval only: %s", exc)
            self.failed = True
            return False

    def scores(self, query: str, wait: bool = False) -> list[float] | None:
        # Never block a request on the first build: use lexical retrieval until
        # the background warm-up has finished.
        if not self.ready:
            if wait:
                self.ensure()
            else:
                self.warm_up()
            if not self.ready:
                return None
        try:
            q = self._embed([query])[0]
        except Exception:  # noqa: BLE001
            return None
        return (self.matrix @ q).tolist()


_embeddings = _EmbeddingIndex()


def warm_up() -> None:
    """Start building the embedding index in the background (call at startup)."""
    _embeddings.warm_up()


def status() -> dict[str, Any]:
    return {
        "properties": len(load_properties()),
        "embedding_model": EMBED_MODEL,
        "embeddings_ready": _embeddings.ready,
        "embeddings_failed": _embeddings.failed,
    }


def search(query: str, k: int = 5, use_embeddings: bool = True) -> list[dict[str, Any]]:
    """Top-k Wikidata properties for a relation phrase. Blocking; call from a thread."""
    lex = _lexical()
    lexical = lex.scores(query)
    dense = _embeddings.scores(query) if use_embeddings else None
    if dense is not None:
        combined = [0.4 * a + 0.6 * b for a, b in zip(lexical, dense)]
    else:
        combined = lexical
    exact = set(lex.exact.get(_norm(query), []))
    order = sorted(range(len(combined)), key=lambda i: (lex.ids[i] not in exact, -combined[i]))
    return [_candidate(lex.ids[i], combined[i], lex.ids[i] in exact) for i in order[:k]]


def _candidate(pid: str, score: float, exact: bool = False, inverse_of: str | None = None) -> dict:
    p = load_properties()[pid]
    mapping = core_mapping(pid)
    return {
        "id": pid,
        "label": p.get("label") or {},
        "description": p.get("description") or {},
        "score": round(score, 4),
        "exact": exact,
        "transitive": p.get("transitive", False),
        "core": mapping[0] if mapping else None,
        "core_inverse": mapping[1] if mapping else False,
        "core_exact": mapping[2] if mapping else False,
        "inverse_of": inverse_of,
    }


def with_inverses(cands: list[dict]) -> list[dict]:
    """Add each candidate's inverse property (Wikidata P1696), so the option
    with the right direction is always on the list."""
    props = load_properties()
    out = list(cands)
    seen = {c["id"] for c in cands}
    for c in cands:
        for inv in (props.get(c["id"]) or {}).get("inverse", []):
            if inv in props and inv not in seen:
                seen.add(inv)
                out.append(_candidate(inv, c["score"], inverse_of=c["id"]))
    return out


# ── Linking ───────────────────────────────────────────────────────────────

ChatFn = Callable[[str, str], Awaitable[str]]

SELECT_CONCURRENCY = 4
MAX_TERMS = 3         # English names searched per relation
TERM_K = 3            # candidates kept per English name
MAX_CANDIDATES = 12   # options shown to the model per relation

# Wikidata states these between classes for a measured order; "A is taller
# than B" between two things is a passing comparison, not this property.
NON_RELATIONAL = {"P5135", "P5136"}
_COMPARATIVE = re.compile(r"보다 |\bthan\b", re.I)

_EXPAND_SYSTEM = (
    "You get a relation phrase from a knowledge graph and example edges (source → target). "
    "Give up to 3 short English names for this relation, worded the way a Wikidata property "
    "label is worded, for the reading 'source RELATION target'. "
    'Return JSON only: {"terms": ["<name>", ...]}'
)

_SELECT_SYSTEM = (
    "You map one free-text relation from a knowledge graph to a Wikidata property. "
    "You get the relation, example edges (source → target) and numbered options. "
    "An option reads 'subject PROPERTY value', where the edge source is the subject and the "
    "target is the value. Option 0 means none of them. "
    "First write one short sentence on what the relation says about source and target, then "
    "choose the option for which 'source PROPERTY target' says the same thing. Choose 0 when "
    "only a loosely related option exists. "
    'Return JSON only: {"reason": "<one sentence>", "choice": <option number>}'
)

_MEANING_SYSTEM = (
    "You get a relation phrase from a knowledge graph, an example edge, and a proposed "
    "Wikidata property. Say what kind of relation the phrase is: a lasting fact about the "
    "source (where, who, what it is made of, what it belongs to), or something subjective or "
    "casual (likes, goes well with, gets along with, is often compared to, is eaten with). "
    "Answer \"no\" if it is subjective or casual, or if the property is about a different "
    "thing. Otherwise answer \"yes\", even when the wording differs from the property. "
    "First write one short sentence. "
    'Return JSON only: {"reason": "<one sentence>", "answer": "yes" | "no"}'
)

_VERIFY_SYSTEM = (
    "You get a Wikidata property and two statements of the form "
    "'SUBJECT —[PROPERTY]→ VALUE' (the subject has this property, and its value is VALUE). "
    "Statements a and b use the same two entities in opposite directions. "
    "First write one short sentence on which entity is the subject of this property, then "
    "answer \"a\" or \"b\" for the statement that is true, or \"none\" if neither is a "
    "correct use of the property. "
    'Return JSON only: {"reason": "<one sentence>", "answer": "a" | "b" | "none"}'
)


def _pick_option(value: Any, cands: list[dict]) -> dict | None:
    """A candidate by 1-based number; a listed property id is accepted too."""
    if isinstance(value, str):
        v = value.strip()
        if not v.isdigit():
            return next((c for c in cands if c["id"] == v), None)
        value = int(v)
    if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= len(cands):
        return cands[value - 1]
    return None


def _unwrap(answer: dict, key: str) -> dict:
    """Small models often drop the wrapper object: accept {key: {...}} or {...}."""
    inner = answer.get(key)
    return inner if isinstance(inner, dict) else answer


def _prop_text(p: dict) -> str:
    label = p.get("label") or {}
    desc = (p.get("description") or {}).get("en") or (p.get("description") or {}).get("ko") or ""
    names = " / ".join(x for x in (label.get("en"), label.get("ko")) if x)
    return f"{names}: {desc}" if desc else names


def _extract_json(text: str) -> dict:
    m = re.search(r"\{[\s\S]*\}", text or "")
    if not m:
        return {}
    try:
        return json.loads(m.group())
    except json.JSONDecodeError:
        return {}


async def link_relations(graph: dict[str, Any], chat: ChatFn | None = None,
                         k: int = 5, use_embeddings: bool = True) -> dict[str, Any]:
    """Link custom edges of a normalized graph to Wikidata, in place.

    Returns a summary {linked, unlinked, method_by_label}. Without `chat`,
    only unique exact matches are linked.
    """
    import asyncio

    nodes = {n.get("id"): n for n in graph.get("nodes") or []}
    custom: dict[str, list[dict]] = {}
    for e in graph.get("edges") or []:
        if not e.get("inferred") and e.get("relation") == vocab.CUSTOM and not e.get("wikidata"):
            custom.setdefault(e["label"], []).append(e)
    if not custom:
        return {"linked": {}, "unlinked": []}

    candidates = {}
    for label in custom:
        found = await asyncio.to_thread(search, label, k, use_embeddings)
        candidates[label] = with_inverses(found)

    def lbl(nid):
        return (nodes.get(nid) or {}).get("label") or nid

    props = load_properties()
    chosen: dict[str, tuple[str, str]] = {}   # label → (pid, method)
    rejected_by: dict[str, list[str]] = {}    # label → checks its pick failed
    for label, cands in candidates.items():
        exact = [c for c in cands if c["exact"]]
        if len(exact) == 1:
            chosen[label] = (exact[0]["id"], "exact")

    # A comparison between two entities is not a fact any property states.
    pending = [label for label in custom
               if label not in chosen and not _COMPARATIVE.search(_norm(label) + " ")]
    if pending and chat is not None:
        # One numbered question per relation: small models miscopy property ids
        # and lose items in a batch, and one timeout no longer costs them all.
        sem = asyncio.Semaphore(SELECT_CONCURRENCY)

        async def expand(label):
            # Korean aliases are sparse on Wikidata, so "부인" alone never
            # retrieves "spouse". Search the model's English names as well.
            examples = "; ".join(f"{lbl(e['source'])} → {lbl(e['target'])}" for e in custom[label][:3])
            async with sem:
                try:
                    answer = _extract_json(await chat(_EXPAND_SYSTEM, f'Phrase: "{label}"\nExamples: {examples}'))
                except Exception as exc:  # noqa: BLE001 — retrieval still has the phrase itself
                    log.warning("relation query expansion failed for %r: %r", label, exc)
                    return
            terms = answer.get("terms")
            terms = [t for t in terms if isinstance(t, str) and t.strip()][:MAX_TERMS] if isinstance(terms, list) else []
            found: list[dict] = []
            for term in terms:
                found += await asyncio.to_thread(search, term, TERM_K, use_embeddings)
            exact_hits = [c for c in found if c["exact"]]
            others = [c for c in found if not c["exact"]]
            merged = with_inverses(exact_hits) + candidates[label] + with_inverses(others)
            candidates[label] = list({c["id"]: c for c in reversed(merged)}.values())[::-1][:MAX_CANDIDATES]

        await asyncio.gather(*(expand(x) for x in pending))

        for label in pending:
            candidates[label] = [c for c in candidates[label] if c["id"] not in NON_RELATIONAL]

        async def select(label, reverse=False):
            examples = "; ".join(f"{lbl(e['source'])} → {lbl(e['target'])}" for e in custom[label][:3])
            cands = candidates[label][::-1] if reverse else candidates[label]
            options = "\n".join(
                f"{i}) {_prop_text(c)}"
                + (" (reverse direction of another option)" if c.get("inverse_of") else "")
                for i, c in enumerate(cands, 1)
            )
            user = f'Relation: "{label}"\nExamples: {examples}\nOptions:\n{options}\n0) none of these'
            async with sem:
                try:
                    answer = _extract_json(await chat(_SELECT_SYSTEM, user))
                except Exception as exc:  # noqa: BLE001 — linking is best-effort
                    log.warning("relation linking LLM call failed for %r: %r", label, exc)
                    return None
            return _pick_option(answer.get("choice"), cands)

        for label, cand in zip(pending, await asyncio.gather(*(select(x) for x in pending))):
            if cand:
                chosen[label] = (cand["id"], "llm")

        # A pick that changes when the same options are listed in another order
        # was a guess: asking again is the cheapest test of that.
        picked = [label for label in pending if label in chosen]
        for label, again in zip(picked, await asyncio.gather(*(select(x, reverse=True) for x in picked))):
            if not again or again["id"] != chosen[label][0]:
                rejected_by.setdefault(label, []).append("vote")

        # The direction check below never sees the phrase, so a true statement
        # under an unrelated property would pass it. A strict "means the same"
        # question cost a quarter of recall on small models; this one only
        # screens out phrases no property records.
        async def same_meaning(label):
            e = custom[label][0]
            user = (f'Relation: "{label}"\nExample: {lbl(e["source"])} → {lbl(e["target"])}\n'
                    f"Property: {_prop_text(props[chosen[label][0]])}")
            async with sem:
                try:
                    answer = _extract_json(await chat(_MEANING_SYSTEM, user))
                except Exception as exc:  # noqa: BLE001 — linking is best-effort
                    log.warning("relation meaning check failed for %r: %r", label, exc)
                    return False
            return str(answer.get("answer", "")).strip().lower() == "yes"

        for label, same in zip(picked, await asyncio.gather(*(same_meaning(x) for x in picked))):
            if not same:
                rejected_by.setdefault(label, []).append("meaning")

    rejected: dict[str, str] = {}
    if chosen and chat is not None:
        # Read every link back in both directions and let the model pick the
        # true one. A contrastive choice is far more reliable for small models
        # than judging one sentence, and it filters out reversed directions.
        items = list(chosen.items())
        sem = asyncio.Semaphore(SELECT_CONCURRENCY)

        async def verify(label, pid):
            e = custom[label][0]
            s, t, prop = lbl(e["source"]), lbl(e["target"]), _prop_text(props[pid])
            name = prop.split(":")[0]
            user = f'Property: {prop}\na) "{s}" —[{name}]→ "{t}"\nb) "{t}" —[{name}]→ "{s}"'
            async with sem:
                try:
                    answer = _extract_json(await chat(_VERIFY_SYSTEM, user))
                except Exception as exc:  # noqa: BLE001 — linking is best-effort
                    log.warning("relation link verification failed for %r: %r", label, exc)
                    return None
            return str(answer.get("answer", "none")).strip(" ()").lower()

        answers = await asyncio.gather(*(verify(label, pid) for label, (pid, _) in items))
        for (label, (pid, method)), ans in zip(items, answers):
            if ans == "a":
                continue
            if ans is None:                      # no verdict: only exact matches stand
                if method != "exact":
                    rejected[label] = pid
                continue
            # "b" is harmless for an exact match (the phrase is the property's
            # own name, so the edge already reads in its direction) and for a
            # symmetric property. Otherwise the pick is dropped, not flipped:
            # 5 of 6 flips were wrong, and inverses are offered at selection.
            if ans == "b" and (method == "exact" or props[pid].get("symmetric")):
                continue
            rejected[label] = pid
            rejected_by.setdefault(label, []).append("direction")
        for label in rejected_by:
            rejected[label] = chosen[label][0]
        for label in rejected:
            chosen.pop(label, None)
    for label, (pid, method) in chosen.items():
        for e in custom[label]:
            _apply_link(e, props[pid], method)

    return {
        "linked": {label: {"id": pid, "method": m} for label, (pid, m) in chosen.items()},
        "rejected": rejected,
        "rejected_by": rejected_by,
        "unlinked": [label for label in custom if label not in chosen],
    }


def _apply_link(edge: dict, prop: dict, method: str) -> None:
    pid = prop["id"]
    edge["wikidata"] = {
        "id": pid,
        "label": prop.get("label") or {},
        "transitive": bool(prop.get("transitive")),
        "method": method,
    }
    mapping = core_mapping(pid)
    if not mapping:
        return
    rel, inverse, exact = mapping
    if exact:
        # Same meaning as a core relation: rewrite the edge to it.
        edge.setdefault("original_label", edge["label"])
        if inverse:
            edge["source"], edge["target"] = edge["target"], edge["source"]
        edge["label"] = rel
        edge["relation"] = rel
    elif rel not in BUILTINS:
        edge["super_relation"] = rel
        edge["super_inverse"] = inverse

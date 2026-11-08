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

_SELECT_SYSTEM = (
    "You map free-text relation labels from a knowledge graph to Wikidata properties. "
    "For each relation you get example edges (source → target) and candidate properties. "
    "A property reads 'subject PROPERTY value', where the edge source is the subject and the "
    "target is the value. Candidates marked (inverse of Pxx) state the reverse direction. "
    "Pick a candidate only if 'source PROPERTY target' says the same thing as the edge; "
    "if no candidate fits, answer null — null is better than a near miss. Never invent ids. "
    'Return JSON only: {"links": {"<relation label>": "<property id or null>"}}'
)

_VERIFY_SYSTEM = (
    "Each item gives a Wikidata property and two statements of the form "
    "'SUBJECT —[PROPERTY]→ VALUE' (the subject has this property, and its value is VALUE). "
    "Statement a and b use the same two entities in opposite directions. "
    "For each item answer \"a\" or \"b\" for the statement that is true, or \"none\" if "
    "neither is a correct use of the property. "
    'Return JSON only: {"answers": {"<item number>": "a" | "b" | "none"}}'
)


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

    chosen: dict[str, tuple[str, str]] = {}   # label → (pid, method)
    for label, cands in candidates.items():
        exact = [c for c in cands if c["exact"]]
        if len(exact) == 1:
            chosen[label] = (exact[0]["id"], "exact")

    pending = [label for label in custom if label not in chosen]
    if pending and chat is not None:
        blocks = []
        for label in pending:
            examples = "; ".join(f"{lbl(e['source'])} → {lbl(e['target'])}" for e in custom[label][:3])
            cands = "\n".join(
                f"   - {c['id']}: {_prop_text(c)}"
                + (f" (inverse of {c['inverse_of']})" if c.get("inverse_of") else "")
                for c in candidates[label]
            )
            blocks.append(f'Relation "{label}" (examples: {examples})\n{cands}')
        try:
            links = _unwrap(_extract_json(await chat(_SELECT_SYSTEM, "\n\n".join(blocks))), "links")
            for label in pending:
                pid = links.get(label)
                allowed = {c["id"] for c in candidates[label]}
                if isinstance(pid, str) and pid in allowed:
                    chosen[label] = (pid, "llm")
        except Exception as exc:  # noqa: BLE001 — linking is best-effort
            log.warning("relation linking LLM call failed: %r", exc)

    props = load_properties()
    rejected: dict[str, str] = {}
    if chosen and chat is not None:
        # Read every link back in both directions and let the model pick the
        # true one. A contrastive choice is far more reliable for small models
        # than judging one sentence, and it catches reversed directions.
        items = list(chosen.items())
        blocks = []
        for i, (label, (pid, _)) in enumerate(items, 1):
            e = custom[label][0]
            s, t, prop = lbl(e["source"]), lbl(e["target"]), _prop_text(props[pid])
            blocks.append(f'{i}. property: {prop}\n   a) "{s}" —[{prop.split(":")[0]}]→ "{t}"\n'
                          f'   b) "{t}" —[{prop.split(":")[0]}]→ "{s}"')
        try:
            answers = _unwrap(_extract_json(await chat(_VERIFY_SYSTEM, "\n".join(blocks))), "answers")
            for i, (label, (pid, method)) in enumerate(items, 1):
                ans = str(answers.get(str(i), answers.get(i, "none"))).strip().lower()
                inverse = (props[pid].get("inverse") or [None])[0]
                if ans == "a":
                    continue
                if method == "exact":
                    # The phrase *is* the property's name, so the edge already
                    # reads in the property's direction; small models still
                    # answer "b" for correct ones (수도→P36 became P1376).
                    # Verification may reject the sense, never flip it.
                    if ans != "b":
                        rejected[label] = pid
                    continue
                if ans == "b" and inverse in props:
                    chosen[label] = (inverse, method + "+inverse")   # right meaning, other direction
                else:
                    rejected[label] = pid
        except Exception as exc:  # noqa: BLE001
            log.warning("relation link verification failed: %r", exc)
            rejected = {label: pid for label, (pid, m) in items if m == "llm"}
        for label in rejected:
            chosen.pop(label, None)
    for label, (pid, method) in chosen.items():
        for e in custom[label]:
            _apply_link(e, props[pid], method)

    return {
        "linked": {label: {"id": pid, "method": m} for label, (pid, m) in chosen.items()},
        "rejected": rejected,
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

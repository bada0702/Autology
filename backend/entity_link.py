"""
Entity linking: attach Wikidata item ids (Q-ids) to graph nodes.

A shared identifier is what lets the knowledge base (knowledge.py) merge
"테슬라" from one run with "Tesla, Inc." from another, and keep homonyms such
as Tesla the company and tesla the SI unit apart.

1. Candidates come from Wikidata's wbsearchentities API (label/alias search,
   Korean and English), fetched concurrently.
2. One batched LLM call picks a candidate per node, using the node type,
   description, its neighbours and the topic as context — or null.
3. Only listed ids are accepted. Nodes that already carry a wikidata_id and
   Literal nodes (values) are skipped.

Linking is best-effort: network or LLM failures leave nodes unlinked.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Awaitable, Callable

import httpx

log = logging.getLogger("autology.entity_link")

API = "https://www.wikidata.org/w/api.php"
USER_AGENT = "Autology/1.0 (ontology builder; https://github.com/bada0702/Autology)"
MAX_CONCURRENCY = 4
CANDIDATES = 5

ChatFn = Callable[[str, str], Awaitable[str]]
SearchFn = Callable[[str, str], Awaitable[list[dict]]]

_HANGUL = re.compile(r"[가-힣]")

_SYSTEM = (
    "You link one knowledge-graph node to a Wikidata item. You get the node's label, type "
    "(Class = a kind of thing, Instance = one specific thing), description, neighbours and the "
    "graph topic, followed by numbered options. Option 0 means none of the candidates. "
    "First write one short sentence on what the node is in this graph, then choose the option "
    "that denotes the same thing. A Class node maps to a general concept, an Instance node to a "
    "specific entity. Choose 0 only when the node is something else: another sense of the word, "
    "or something local such as an internal project, server, team or room. "
    'Return JSON only: {"reason": "<one sentence>", "choice": <option number>}'
)
# Measured on fixed cases with qwen3.5:4b (3 runs each): asking for the choice
# alone picked the correct, only candidate 40% of the time; reason-first with
# an explicit "0) none" option and temperature 0 got 100%, still rejecting
# local names that collide with Wikidata items (아폴로, 피닉스, 해바라기).


def _pick(answer: dict, cands: list[dict]) -> dict | None:
    """Candidate chosen by number ({"choice": 2}); a listed Q-id is accepted too."""
    choice = answer.get("choice", answer.get("id"))
    if isinstance(choice, str):
        if choice.strip().isdigit():
            choice = int(choice.strip())
        else:
            return next((c for c in cands if c["id"] == choice.strip()), None)
    if isinstance(choice, int) and not isinstance(choice, bool) and 1 <= choice <= len(cands):
        return cands[choice - 1]
    return None

# Items that are never the meaning of a node.
_NON_ENTITY = re.compile(
    r"disambiguation page|위키미디어 동음이의어|wikimedia (list|category|template)|"
    r"위키미디어 (목록|분류|틀)|scientific article|학술 논문", re.I)


def _norm(text: str) -> str:
    return re.sub(r"[\s_\-·.,()]+", "", str(text or "").lower())


def filter_candidates(label: str, items: list[dict]) -> list[dict]:
    """Drop non-entities; if some candidates match the label/alias exactly,
    keep only those (wbsearchentities also returns prefix matches)."""
    items = [it for it in items if not _NON_ENTITY.search(it.get("description") or "")]
    exact = [it for it in items
             if _norm(it.get("match_text")) == _norm(label) or _norm(it.get("label")) == _norm(label)]
    if not exact:
        return items
    # Search's own top hit stays even when its label differs: "아마존" ranks
    # Amazon (아마존닷컴) first, while the only exact label is a chess piece.
    # Only the top hit, so prefix matches like 테슬라 모델 S stay out.
    if items[0] not in exact:
        exact.append(items[0])
    return exact

_cache: dict[tuple[str, str], list[dict]] = {}


async def search_entities(query: str, lang: str, client: httpx.AsyncClient | None = None) -> list[dict]:
    key = (query, lang)
    if key in _cache:
        return _cache[key]
    params = {"action": "wbsearchentities", "search": query, "language": lang,
              "uselang": lang, "limit": CANDIDATES, "format": "json", "type": "item"}
    own = client is None
    client = client or httpx.AsyncClient(timeout=10, headers={"User-Agent": USER_AGENT})
    try:
        r = await client.get(API, params=params)
        r.raise_for_status()
        items = [{
            "id": it["id"],
            "label": it.get("label", ""),
            "description": it.get("description", ""),
            "match": (it.get("match") or {}).get("type", ""),
            "match_text": (it.get("match") or {}).get("text", ""),
        } for it in r.json().get("search", [])]
    finally:
        if own:
            await client.aclose()
    _cache[key] = items
    return items


def _extract_json(text: str) -> dict:
    m = re.search(r"\{[\s\S]*\}", text or "")
    if not m:
        return {}
    try:
        return json.loads(m.group())
    except json.JSONDecodeError:
        return {}


async def link_entities(graph: dict[str, Any], chat: ChatFn | None,
                        topic: str = "", search: SearchFn | None = None) -> dict[str, Any]:
    """Attach wikidata_id/_label/_description to nodes in place; returns a summary."""
    nodes = [n for n in graph.get("nodes") or []
             if n.get("type") != "Literal" and not n.get("wikidata_id") and n.get("label")]
    if not nodes or chat is None:
        return {"linked": {}, "unlinked": [n.get("label") for n in nodes]}

    by_id = {n.get("id"): n for n in graph.get("nodes") or []}
    neighbours: dict[str, list[str]] = {}
    for e in graph.get("edges") or []:
        if e.get("inferred"):
            continue
        s, t = by_id.get(e.get("source")), by_id.get(e.get("target"))
        if s and t:
            neighbours.setdefault(s["id"], []).append(f"{e.get('label')} {t.get('label')}")
            neighbours.setdefault(t["id"], []).append(f"{s.get('label')} (via {e.get('label')})")

    sem = asyncio.Semaphore(MAX_CONCURRENCY)

    async with httpx.AsyncClient(timeout=10, headers={"User-Agent": USER_AGENT}) as client:
        async def fetch(node):
            label = node["label"]
            langs = ["ko", "en"] if _HANGUL.search(label) else ["en", "ko"]
            found: dict[str, dict] = {}
            async with sem:
                for lang in langs:
                    try:
                        items = await (search(label, lang) if search else search_entities(label, lang, client))
                    except Exception as exc:  # noqa: BLE001
                        log.info("entity search failed for %r: %r", label, exc)
                        items = []
                    for it in items:
                        found.setdefault(it["id"], it)
            return filter_candidates(label, list(found.values()))[:CANDIDATES]

        candidate_lists = await asyncio.gather(*(fetch(n) for n in nodes))

    # One short call per node: a single batched prompt with dozens of
    # candidate lines makes small models mix up items.
    async def choose(node, cands):
        ctx = "; ".join(neighbours.get(node["id"], [])[:4])
        # Numbered options: small models miscopy Q-ids (Q584 came back as
        # Q230) but pick a small number reliably.
        lines = "\n".join(f"{i}) {c['label']} — {c['description'] or '(no description)'}"
                          for i, c in enumerate(cands, 1)) + "\n0) none of these"
        user = ((f"Graph topic: {topic}\n" if topic else "")
                + f"Node: \"{node['label']}\" (type: {node.get('type', 'Class')})\n"
                + (f"Description: {node['description']}\n" if node.get("description") else "")
                + (f"Neighbours: {ctx}\n" if ctx else "")
                + f"Candidates:\n{lines}")
        async with sem:
            try:
                answer = _extract_json(await chat(_SYSTEM, user))
            except Exception as exc:  # noqa: BLE001 — linking is best-effort
                log.warning("entity linking LLM call failed for %r: %r", node["label"], exc)
                return None
        return _pick(answer, cands)

    work = [(n, c) for n, c in zip(nodes, candidate_lists) if c]
    choices = await asyncio.gather(*(choose(n, c) for n, c in work))

    linked: dict[str, str] = {}
    for (node, _), match in zip(work, choices):
        if match:
            node["wikidata_id"] = match["id"]
            node["wikidata_label"] = match["label"]
            node["wikidata_description"] = match["description"]
            linked[node["label"]] = match["id"]

    return {"linked": linked, "unlinked": [n["label"] for n in nodes if n["label"] not in linked]}

"""
Automatic repair of rule violations, gated by the reasoner.

The reasoner (reasoning.py) scores a graph; the LLM's opinion of its own output
is never used. Each change is applied to a copy, re-scored, and kept only if
the score improves, so a weak model can fix less but cannot make a graph worse.

  1. Rule fixes, no LLM: dangling edges, instances used as classes, reversed
     has-property edges from a literal.
  2. LLM fixes, errors only: the checker proved a set of statements cannot all
     be true (cycle, disjointness). The model sees just those statements and
     names the false one, or says it cannot tell.

Nodes are never deleted, edge removals are capped, and every removed edge is
kept in the report so it can be restored. The score covers logic and structure
only: a false statement that breaks no rule still scores full marks.
"""
from __future__ import annotations

import copy
import logging
from typing import Any, Awaitable, Callable

import vocabulary as vocab
from entity_link import _extract_json
from explore import Explorer
from reasoning import Fact, analyze

log = logging.getLogger("autology")

ChatFn = Callable[[str, str], Awaitable[str]]

ERROR_PENALTY = 15
WARNING_PENALTY = 3
MAX_ROUNDS = 2
MAX_LLM_CALLS = 8
MAX_OPTIONS = 8
MAX_REMOVED_RATIO = 0.2       # of the graph's edges, at least one
MIN_KEPT_NODES_RATIO = 0.8    # a refined graph must keep this share of the nodes

# Issues counted once per affected item rather than once per report line.
_PER_NODE = {"orphan_node"}
_PER_EDGE = {"duplicate_edge"}

_LLM_FIXABLE = {"cycle", "disjoint_violation", "unsatisfiable_class", "literal_source",
                "type_target_not_class", "class_axiom_on_non_class"}

_SYSTEM = (
    "You repair a knowledge graph. A logic checker proved that the numbered statements cannot "
    "all be true, so at least one is false. Option 0 means you cannot tell. "
    "First write one short sentence on what is actually true about these things, then choose "
    "the statement that is false. "
    'Return JSON only: {"reason": "<one sentence>", "choice": <option number>}'
)


def _clean(graph: dict[str, Any]) -> dict[str, Any]:
    return vocab.normalize_graph(copy.deepcopy(graph))


def _weight(issue: dict[str, Any]) -> int:
    if issue["code"] in _PER_NODE:
        return max(1, len(issue["node_ids"]))
    if issue["code"] in _PER_EDGE:
        return max(1, len(issue["edge_ids"]))
    return 1


def quality(graph: dict[str, Any]) -> dict[str, Any]:
    """Rule score of a graph. `penalty` is uncapped so that graphs at score 0 still compare."""
    issues = analyze(graph)["issues"]
    errors = sum(_weight(i) for i in issues if i["severity"] == "error")
    warnings = sum(_weight(i) for i in issues if i["severity"] == "warn")
    penalty = ERROR_PENALTY * errors + WARNING_PENALTY * warnings
    return {"score": max(0, 100 - penalty), "errors": errors, "warnings": warnings, "penalty": penalty}


def not_worse(current: dict[str, Any], candidate: dict[str, Any]) -> bool:
    """May `candidate` replace `current`? Used for LLM-rewritten graphs."""
    kept = len(candidate.get("nodes") or []) >= MIN_KEPT_NODES_RATIO * len(current.get("nodes") or [])
    return kept and quality(_clean(candidate))["penalty"] <= quality(_clean(current))["penalty"]


# ── Rule fixes ───────────────────────────────────────────────────────────

def _rule_fixes(g: dict[str, Any]) -> list[dict[str, Any]]:
    """Apply fixes that need no judgement to `g`, returning what was done."""
    actions: list[dict[str, Any]] = []
    nodes = {n.get("id"): n for n in g.get("nodes") or []}

    def label(nid):
        return (nodes.get(nid) or {}).get("label") or nid

    kept = []
    for e in g.get("edges") or []:
        if not e.get("inferred") and (e.get("source") not in nodes or e.get("target") not in nodes):
            actions.append({"kind": "remove_dangling_edge", "by": "rule", "statement": e.get("label", ""),
                            "edge": copy.deepcopy(e)})
        else:
            kept.append(e)
    g["edges"] = kept

    for e in kept:
        if e.get("inferred"):
            continue
        src, tgt = nodes[e["source"]], nodes[e["target"]]
        # "수성 is-a 행성" with 행성 typed Instance was downgraded to related-to
        # by normalization. The statement is fine; the target's type is wrong.
        if "is-a between two instances" in (e.get("normalization_note") or "") and e.get("original_label"):
            tgt["type"] = "Class"
            e["label"] = e["original_label"]
            e.pop("normalization_note", None)
            e.pop("relation", None)
            actions.append({"kind": "promote_to_class", "by": "rule", "node": tgt.get("label")})
            continue
        # Something has instances or subclasses, so it is a class.
        if e["label"] in (vocab.TYPE, vocab.SUBCLASS) and tgt.get("type") == "Instance":
            tgt["type"] = "Class"
            actions.append({"kind": "promote_to_class", "by": "rule", "node": tgt.get("label")})
        # "빨강 has-property 사과" states the property backwards.
        if e["label"] == "has-property" and src.get("type") == "Literal" and tgt.get("type") != "Literal":
            e["source"], e["target"] = e["target"], e["source"]
            actions.append({"kind": "reverse_edge", "by": "rule",
                            "statement": f"{label(e['source'])} has-property {label(e['target'])}"})
    return actions


# ── LLM fixes ────────────────────────────────────────────────────────────

def _key(issue: dict[str, Any]) -> tuple[str, str]:
    return issue["code"], issue["message"]


def _suspects(g: dict[str, Any], issue: dict[str, Any]) -> list[str]:
    """Asserted edges the issue rests on: the statements that could be false."""
    if issue["edge_ids"]:
        return list(issue["edge_ids"])
    if issue["code"] not in ("disjoint_violation", "unsatisfiable_class"):
        return []
    # Issue node_ids are [x, a, b]: x is in (or under) both of the disjoint classes.
    x, a, b = issue["node_ids"]
    rel = vocab.TYPE if issue["code"] == "disjoint_violation" else vocab.SUBCLASS
    ex = Explorer(g)
    out: list[str] = []
    for cls in (a, b):
        if cls != x:
            out += [e for e in ex.evidence(Fact(x, rel, cls)) if e not in out]
    out += [e["id"] for e in g.get("edges") or []
            if e.get("label") == vocab.DISJOINT and {e.get("source"), e.get("target")} == {a, b}
            and e["id"] not in out]
    return out


async def _ask(chat: ChatFn, g: dict[str, Any], issue: dict[str, Any], topic: str,
               suspects: list[str]) -> tuple[str | None, str]:
    """Ask which suspect is false. Returns (edge id or None, the model's reason)."""
    nodes = {n.get("id"): n for n in g.get("nodes") or []}
    edges = {e["id"]: e for e in g.get("edges") or [] if e.get("id")}

    def text(eid):
        e = edges[eid]
        lab = lambda n: (nodes.get(n) or {}).get("label") or n  # noqa: E731
        return f"{lab(e['source'])} {e['label']} {lab(e['target'])}"

    options = "\n".join(f"{i}) {text(eid)}" for i, eid in enumerate(suspects, 1))
    user = ((f"Graph topic: {topic}\n" if topic else "") + f"Problem: {issue['message']}\n"
            + f"Statements:\n{options}\n0) cannot tell")
    answer = _extract_json(await chat(_SYSTEM, user))
    choice = answer.get("choice")
    if isinstance(choice, str) and choice.strip().isdigit():
        choice = int(choice.strip())
    reason = str(answer.get("reason") or "")
    if isinstance(choice, int) and not isinstance(choice, bool) and 1 <= choice <= len(suspects):
        return suspects[choice - 1], reason
    return None, reason


def _statement(g: dict[str, Any], edge: dict[str, Any]) -> str:
    nodes = {n.get("id"): n for n in g.get("nodes") or []}
    lab = lambda n: (nodes.get(n) or {}).get("label") or n  # noqa: E731
    return f"{lab(edge['source'])} {edge['label']} {lab(edge['target'])}"


# ── The loop ─────────────────────────────────────────────────────────────

async def repair_graph(graph: dict[str, Any], chat: ChatFn | None = None, topic: str = "",
                       max_rounds: int = MAX_ROUNDS) -> dict[str, Any]:
    """Repair `graph` in place and return a report. Without `chat`, rule fixes only."""
    current = _clean(graph)
    before = quality(current)
    report: dict[str, Any] = {"before": _public(before), "actions": [], "rejected": [], "removed_edges": []}

    candidate = copy.deepcopy(current)
    actions = _rule_fixes(candidate)
    if actions:
        vocab.normalize_graph(candidate)
        if quality(candidate)["penalty"] < quality(current)["penalty"]:
            current = candidate
            report["actions"] += actions
            report["removed_edges"] += [a["edge"] for a in actions if "edge" in a]
        else:
            report["rejected"] += [{**a, "why": "score did not improve"} for a in actions]

    budget = max(1, int(len(current.get("edges") or []) * MAX_REMOVED_RATIO))
    removed = calls = 0
    tried: set[tuple[str, str]] = set()
    for _ in range(max_rounds if chat else 0):
        progress = False
        for issue in analyze(current)["issues"]:
            if issue["severity"] != "error" or issue["code"] not in _LLM_FIXABLE or _key(issue) in tried:
                continue
            if removed >= budget or calls >= MAX_LLM_CALLS:
                break
            # An earlier removal in this pass may already have fixed it.
            if _key(issue) not in {_key(i) for i in analyze(current)["issues"]}:
                continue
            tried.add(_key(issue))
            suspects = _suspects(current, issue)[:MAX_OPTIONS]
            if not suspects:
                continue
            calls += 1
            try:
                eid, reason = await _ask(chat, current, issue, topic, suspects)
            except Exception as exc:  # noqa: BLE001 — repair is best-effort
                log.warning("repair LLM call failed: %r", exc)
                continue
            if eid is None:
                continue
            edge = next(e for e in current["edges"] if e.get("id") == eid)
            trial = copy.deepcopy(current)
            trial["edges"] = [e for e in trial["edges"] if e.get("id") != eid]
            statement = _statement(current, edge)
            if quality(trial)["penalty"] < quality(current)["penalty"]:
                current = trial
                removed += 1
                progress = True
                report["actions"].append({"kind": "remove_edge", "by": "llm", "statement": statement,
                                          "issue": issue["message"], "reason": reason})
                report["removed_edges"].append(copy.deepcopy(edge))
            else:
                report["rejected"].append({"kind": "remove_edge", "by": "llm", "statement": statement,
                                           "why": "score did not improve"})
        if not progress:
            break

    graph["nodes"] = current.get("nodes") or []
    graph["edges"] = current.get("edges") or []
    final = analyze(current)["issues"]
    report["after"] = _public(quality(current))
    report["unresolved"] = [i["message"] for i in final if i["severity"] == "error"]
    return report


def _public(q: dict[str, Any]) -> dict[str, Any]:
    return {k: q[k] for k in ("score", "errors", "warnings")}

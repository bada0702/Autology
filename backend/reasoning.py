"""
Deterministic reasoning and validation for Autology graphs.

Reasoning implements the OWL 2 RL rules that matter for the core vocabulary
(vocabulary.py), with provenance: every inferred edge records the rule and
the premise edges it came from, so answers can be traced back to evidence.
owlrl computes the same closure (see tests) but cannot say *why* a triple
holds, which the exploration layer needs.

    prp-trp   p transitive, (x p y), (y p z)        → (x p z)
    prp-spo2  p ⊒ p1∘p2,     (x p1 y), (y p2 z)      → (x p z)
    scm-sco   subClassOf is transitive (handled as prp-trp)
    cax-sco   (x type C), (C ⊑ D)                    → (x type D)
    cax-eqc   (x type C), (C ≡ D)                    → (x type D)

Symmetric relations are not materialized in reverse: the canvas would only
gain mirror-image edges.

Validation is rule-based, not LLM-based: structural defects, cycles in
relations that must be acyclic, disjointness violations over the inferred
closure, and relations that are not in the vocabulary yet.
"""

from __future__ import annotations

import copy
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

import vocabulary as vocab

MAX_INFERRED = 5000

# Relations whose cycles are logical errors. A subClassOf cycle means the
# classes are equivalent, which is legal but almost always an extraction slip.
ACYCLIC = {
    vocab.SUBCLASS: "warn",
    "part-of": "error",
    "located-in": "error",
    "precedes": "error",
}

RULE_TEXT = {
    "prp-trp": "이행성",
    "prp-spo2": "속성 체인",
    "cax-sco": "상위 클래스 상속",
    "cax-eqc": "동치 클래스",
    "prp-spo1": "상위 속성",
    "prp-symp": "대칭성",
}


@dataclass(frozen=True)
class Fact:
    s: str
    p: str
    o: str


def _class_like(node_type: str | None) -> bool:
    return node_type not in ("Instance", "Literal")


def analyze(graph: dict[str, Any]) -> dict[str, Any]:
    """Run reasoning + validation. The input graph is not modified."""
    g = vocab.normalize_graph(copy.deepcopy(graph))
    nodes = g.get("nodes") or []
    node_by_id = {n.get("id"): n for n in nodes}
    direct = [e for e in g.get("edges") or [] if not e.get("inferred")]

    closure, why, order = _infer(direct, node_by_id)
    inferred_edges = _materialize(order, why, direct, node_by_id)
    issues = _validate(graph, g, direct, closure, node_by_id)

    return {
        "inferred": inferred_edges,
        "issues": issues,
        "stats": {
            "direct_edges": len(direct),
            "inferred_edges": len(inferred_edges),
            "errors": sum(1 for i in issues if i["severity"] == "error"),
            "warnings": sum(1 for i in issues if i["severity"] == "warn"),
            "truncated": len(inferred_edges) >= MAX_INFERRED,
        },
    }


# ── Reasoning ────────────────────────────────────────────────────────────

def _infer(direct, node_by_id):
    facts: set[Fact] = set()
    why: dict[Fact, tuple[str, list[Fact]] | str] = {}
    for e in direct:
        if e["source"] in node_by_id and e["target"] in node_by_id:
            f = Fact(e["source"], e["label"], e["target"])
            if f not in facts:
                facts.add(f)
                why[f] = e["id"]

    transitive = {r.id for r in vocab.CORE_RELATIONS if r.transitive}
    chains = [(r.id, p1, p2) for r in vocab.CORE_RELATIONS for p1, p2 in r.chains]

    order: list[Fact] = []   # inferred facts in derivation order (premises first)

    def add(f: Fact, rule: str, premises: list[Fact]) -> bool:
        if f in facts:
            return False
        facts.add(f)
        why[f] = (rule, premises)
        order.append(f)
        return True

    # Custom relations linked to Wikidata (vocab_rag.py):
    #   prp-spo1  (x p y), p ⊑ q            → (x q y)   (q may be inverted)
    #   prp-trp   for properties Wikidata marks transitive
    for e in direct:
        if e.get("relation") != vocab.CUSTOM:
            continue
        base = Fact(e["source"], e["label"], e["target"])
        if base not in facts:
            continue
        if (e.get("wikidata") or {}).get("transitive"):
            transitive.add(e["label"])
        sup = e.get("super_relation")
        if sup:
            s, o = (base.o, base.s) if e.get("super_inverse") else (base.s, base.o)
            add(Fact(s, sup, o), "prp-spo1", [base])

    changed = True
    while changed and len(order) < MAX_INFERRED:
        changed = False
        by_sp = defaultdict(list)          # (subject, predicate) → facts
        eq_by_o = defaultdict(list)        # equivalentClass facts by object
        for f in facts:
            by_sp[(f.s, f.p)].append(f)
            if f.p == vocab.EQUIVALENT_CLASS:
                eq_by_o[f.o].append(f)
        for f in list(facts):
            # prp-symp
            if f.p in vocab.SYMMETRIC:
                changed |= add(Fact(f.o, f.p, f.s), "prp-symp", [f])
            # prp-trp
            if f.p in transitive:
                for g2 in by_sp.get((f.o, f.p), ()):
                    changed |= add(Fact(f.s, f.p, g2.o), "prp-trp", [f, g2])
            # prp-spo2
            for target, p1, p2 in chains:
                if f.p == p1:
                    for g2 in by_sp.get((f.o, p2), ()):
                        changed |= add(Fact(f.s, target, g2.o), "prp-spo2", [f, g2])
            # cax-sco / cax-eqc
            if f.p == vocab.TYPE:
                for g2 in by_sp.get((f.o, vocab.SUBCLASS), ()):
                    changed |= add(Fact(f.s, vocab.TYPE, g2.o), "cax-sco", [f, g2])
                for g2 in by_sp.get((f.o, vocab.EQUIVALENT_CLASS), ()):
                    changed |= add(Fact(f.s, vocab.TYPE, g2.o), "cax-eqc", [f, g2])
                for g2 in eq_by_o.get(f.o, ()):
                    changed |= add(Fact(f.s, vocab.TYPE, g2.s), "cax-eqc", [f, g2])
    return facts, why, order


def _materialize(order, why, direct, node_by_id):
    """Turn inferred facts into canvas edges with ids, premises and an explanation."""
    edge_id: dict[Fact, str] = {}
    for f, w in why.items():
        if isinstance(w, str):
            edge_id[f] = w
    existing = {(e["source"], e["label"], e["target"]) for e in direct}

    def label_of(nid):
        return (node_by_id.get(nid) or {}).get("label") or nid

    out = []
    # Derivation order guarantees premises already have ids. Reflexive facts
    # (x p x) are kept in the closure for cycle detection but not drawn, so a
    # premise can occasionally be one of them; its id is then None.
    for i, f in enumerate(order):
        if f.s == f.o or (f.s, f.p, f.o) in existing:
            continue
        rule, premises = why[f]
        eid = f"inf_{i + 1}"
        edge_id[f] = eid
        # The reverse reading of an asserted symmetric edge adds nothing to
        # look at; it stays in the closure but the canvas need not draw it.
        mirror = rule == "prp-symp" and isinstance(why.get(premises[0]), str)
        out.append({
            "id": eid,
            "source": f.s,
            "target": f.o,
            "label": f.p,
            "relation": f.p,
            "style": "dashed",
            "inferred": True,
            "ruleId": "owl-rl",
            "rule": rule,
            "premises": [edge_id.get(p) for p in premises],
            "explanation": " + ".join(
                f"{label_of(p.s)} {p.p} {label_of(p.o)}" for p in premises
            ) + f" → {RULE_TEXT.get(rule, rule)}({rule})",
            **({"mirror": True} if mirror else {}),
        })
        if len(out) >= MAX_INFERRED:
            break
    return out


# ── Validation ───────────────────────────────────────────────────────────

def _issue(severity, code, message, node_ids=(), edge_ids=()):
    return {
        "severity": severity,
        "code": code,
        "message": message,
        "node_ids": list(node_ids),
        "edge_ids": list(edge_ids),
    }


def _validate(raw, g, direct, closure, node_by_id):
    issues = []

    def label_of(nid):
        return (node_by_id.get(nid) or {}).get("label") or nid

    # Structure — checked on the raw graph so normalization cannot hide it.
    for e in raw.get("edges") or []:
        if e.get("inferred"):
            continue
        s, t = e.get("source"), e.get("target")
        if s not in node_by_id or t not in node_by_id:
            issues.append(_issue("error", "dangling_edge",
                                 f"엣지 '{e.get('label', '')}'가 존재하지 않는 노드를 가리킵니다.",
                                 edge_ids=[e.get("id")]))
        elif s == t:
            issues.append(_issue("warn", "self_loop",
                                 f"'{label_of(s)}'에 자기 자신을 가리키는 엣지가 있습니다.",
                                 node_ids=[s], edge_ids=[e.get("id")]))
    raw_ids = [e.get("id") for e in raw.get("edges") or []
               if not e.get("inferred") and e.get("source") != e.get("target")]
    kept = {e["id"] for e in direct}
    dupes = [i for i in raw_ids if i not in kept]
    if dupes:
        issues.append(_issue("warn", "duplicate_edge",
                             f"정규화 후 중복되는 엣지 {len(dupes)}개가 있습니다.",
                             edge_ids=dupes))

    connected = {e["source"] for e in direct} | {e["target"] for e in direct}
    orphans = [nid for nid in node_by_id if nid not in connected]
    if orphans:
        issues.append(_issue("warn", "orphan_node",
                             f"연결되지 않은 노드 {len(orphans)}개: "
                             + ", ".join(label_of(n) for n in orphans[:8]),
                             node_ids=orphans))

    # Types
    for e in direct:
        st = (node_by_id.get(e["source"]) or {}).get("type")
        tt = (node_by_id.get(e["target"]) or {}).get("type")
        if st == "Literal":
            issues.append(_issue("error" if tt == "Literal" else "warn", "literal_source",
                                 f"값(Literal) '{label_of(e['source'])}'에서 나가는 관계 "
                                 f"'{e['label']}'가 있습니다.",
                                 node_ids=[e["source"]], edge_ids=[e["id"]]))
        if e["label"] == vocab.TYPE and not _class_like(tt):
            issues.append(_issue("error", "type_target_not_class",
                                 f"'{label_of(e['source'])}' rdf:type의 대상 "
                                 f"'{label_of(e['target'])}'가 클래스가 아닙니다.",
                                 node_ids=[e["target"]], edge_ids=[e["id"]]))
        if e["label"] in (vocab.SUBCLASS, vocab.EQUIVALENT_CLASS, vocab.DISJOINT) and not (
                _class_like(st) and _class_like(tt)):
            issues.append(_issue("error", "class_axiom_on_non_class",
                                 f"'{e['label']}'는 클래스 사이에만 쓸 수 있습니다: "
                                 f"{label_of(e['source'])} → {label_of(e['target'])}",
                                 node_ids=[e["source"], e["target"]], edge_ids=[e["id"]]))

    # Cycles in relations that must be acyclic (found as x p x in the closure).
    for rel, severity in ACYCLIC.items():
        on_cycle = {f.s for f in closure if f.p == rel and f.s == f.o}
        reported: set[str] = set()
        for nid in sorted(on_cycle):
            if nid in reported:
                continue
            members = {nid} | {f.o for f in closure
                               if f.p == rel and f.s == nid and Fact(f.o, rel, nid) in closure}
            reported |= members
            edge_ids = [e["id"] for e in direct
                        if e["label"] == rel and e["source"] in members and e["target"] in members]
            issues.append(_issue(severity, "cycle",
                                 f"'{rel}' 관계에 순환이 있습니다: "
                                 + " → ".join(label_of(m) for m in sorted(members)),
                                 node_ids=sorted(members), edge_ids=edge_ids))

    # Disjointness over the inferred closure.
    disjoint = {(f.s, f.o) for f in closure if f.p == vocab.DISJOINT}
    disjoint |= {(b, a) for a, b in disjoint}
    types = defaultdict(set)
    supers = defaultdict(set)
    for f in closure:
        if f.p == vocab.TYPE:
            types[f.s].add(f.o)
        elif f.p == vocab.SUBCLASS:
            supers[f.s].add(f.o)
    done = set()
    for x, cs in types.items():
        for a in cs:
            for b in cs:
                if a < b and (a, b) in disjoint and (x, a, b) not in done:
                    done.add((x, a, b))
                    issues.append(_issue("error", "disjoint_violation",
                                         f"'{label_of(x)}'가 서로소 클래스 '{label_of(a)}'와 "
                                         f"'{label_of(b)}'에 동시에 속합니다.",
                                         node_ids=[x, a, b]))
    for c, ss in supers.items():
        ss = ss | {c}
        for a in ss:
            for b in ss:
                if a < b and (a, b) in disjoint:
                    issues.append(_issue("error", "unsatisfiable_class",
                                         f"클래스 '{label_of(c)}'가 서로소인 '{label_of(a)}'와 "
                                         f"'{label_of(b)}'의 하위 클래스라서 인스턴스를 가질 수 없습니다.",
                                         node_ids=[c, a, b]))

    for e in direct:
        if e.get("normalization_note"):
            issues.append(_issue("warn", "relation_downgraded",
                                 f"'{label_of(e['source'])}' → '{label_of(e['target'])}'의 "
                                 f"'{e.get('original_label', '')}'를 해석할 수 없어 related-to로 "
                                 f"바꿨습니다 ({e['normalization_note']}).",
                                 node_ids=[e["source"], e["target"]], edge_ids=[e["id"]]))

    custom = [e for e in direct if e.get("relation") == vocab.CUSTOM]
    unlinked = [e for e in custom if not e.get("wikidata")]
    linked = [e for e in custom if e.get("wikidata")]
    if unlinked:
        names = sorted({e["label"] for e in unlinked})
        issues.append(_issue("info", "custom_relation",
                             f"어휘에 없는 관계 {len(names)}종 (추론 대상 아님): "
                             + ", ".join(names[:8]),
                             edge_ids=[e["id"] for e in unlinked]))
    if linked:
        names = sorted({f"{e['label']}→{e['wikidata']['id']}" for e in linked})
        issues.append(_issue("info", "wikidata_linked",
                             f"Wikidata 속성에 연결된 관계 {len(names)}종: " + ", ".join(names[:8]),
                             edge_ids=[e["id"] for e in linked]))

    order = {"error": 0, "warn": 1, "info": 2}
    issues.sort(key=lambda i: order[i["severity"]])
    return issues


def issues_for_prompt(issues: list[dict[str, Any]], limit: int = 10) -> str:
    """Compact issue list for an LLM critic/editor prompt."""
    rows = [f"- [{i['severity']}] {i['code']}: {i['message']}"
            for i in issues if i["severity"] != "info"][:limit]
    return "\n".join(rows)

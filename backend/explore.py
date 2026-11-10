"""
Path exploration with provenance.

Answers "how is A connected to B?" and "what do we know about A?" over a
graph (the canvas graph or the knowledge base), using both asserted edges and
facts inferred by the OWL 2 RL reasoner (reasoning.py). Every answer carries
its evidence:

  * asserted facts → the edge id, its sources (knowledge base provenance),
    the original phrasing and any Wikidata link
  * inferred facts → a derivation tree down to asserted edges

Path search enumerates simple paths in order of length, pruned with the
distance to the target so the search stays bounded on dense closures.
"""
from __future__ import annotations

import copy
from collections import defaultdict, deque
from typing import Any, Iterable

import vocabulary as vocab
from knowledge import norm_label
from reasoning import RULE_TEXT, Fact, _infer

MAX_HOPS = 6
MAX_PATHS = 20
MAX_EXPANSIONS = 20000
MAX_DERIVATION_DEPTH = 12


class Explorer:
    def __init__(self, graph: dict[str, Any], include_inferred: bool = True):
        g = vocab.normalize_graph(copy.deepcopy(graph))
        self.nodes: dict[str, dict] = {n["id"]: n for n in g.get("nodes") or [] if n.get("id")}
        direct = [e for e in g.get("edges") or []
                  if not e.get("inferred") and e.get("source") in self.nodes and e.get("target") in self.nodes]
        self.edges: dict[str, dict] = {e["id"]: e for e in direct}

        if include_inferred:
            facts, why, _ = _infer(direct, self.nodes)
        else:
            facts, why = set(), {}
            for e in direct:
                f = Fact(e["source"], e["label"], e["target"])
                if f not in facts:
                    facts.add(f)
                    why[f] = e["id"]
        self.why = why

        # Undirected adjacency over facts; reflexive facts are not steps.
        self.adj: dict[str, dict[str, list[Fact]]] = defaultdict(lambda: defaultdict(list))
        self.by_node: dict[str, list[Fact]] = defaultdict(list)
        for f in facts:
            if f.s == f.o or self._is_mirror(f):
                continue
            self.adj[f.s][f.o].append(f)
            self.adj[f.o][f.s].append(f)
            self.by_node[f.s].append(f)
            self.by_node[f.o].append(f)
        self._derivations: dict[Fact, dict] = {}

    def _is_mirror(self, f: Fact) -> bool:
        """B p A derived only by symmetry from an asserted A p B: already
        covered, since symmetric facts are read in both directions here."""
        w = self.why.get(f)
        return (isinstance(w, tuple) and w[0] == "prp-symp"
                and isinstance(self.why.get(w[1][0]), str))

    # ── Node lookup ──────────────────────────────────────────────────────

    def resolve(self, query: str) -> list[str]:
        """Node ids for an id, label, alias or Wikidata id (exact first, then substring)."""
        q = (query or "").strip()
        if not q:
            return []
        if q in self.nodes:
            return [q]
        nq = norm_label(q)
        exact, partial = [], []
        for nid, n in self.nodes.items():
            names = [n.get("label") or "", *(n.get("aliases") or [])]
            normed = [norm_label(x) for x in names]
            if nq in normed or n.get("wikidata_id") == q:
                exact.append(nid)
            elif any(nq in x for x in normed if x):
                partial.append(nid)
        return exact or partial

    def label(self, nid: str) -> str:
        return (self.nodes.get(nid) or {}).get("label") or nid

    # ── Facts and their evidence ─────────────────────────────────────────

    def statement(self, f: Fact) -> str:
        return f"{self.label(f.s)} {f.p} {self.label(f.o)}"

    def is_inferred(self, f: Fact) -> bool:
        return not isinstance(self.why.get(f), str)

    def derivation(self, f: Fact, depth: int = 0) -> dict[str, Any]:
        """Proof tree for a fact: asserted leaves with sources, rules at inner nodes."""
        if f in self._derivations:
            return self._derivations[f]
        w = self.why.get(f)
        if isinstance(w, str):
            e = self.edges.get(w, {})
            out = {"statement": self.statement(f), "asserted": True, "edge_id": w,
                   "sources": e.get("sources") or []}
            if e.get("original_label") and e["original_label"] != e.get("label"):
                out["original_label"] = e["original_label"]
        elif w is None:
            out = {"statement": self.statement(f), "unknown": True}
        elif depth >= MAX_DERIVATION_DEPTH:
            return {"statement": self.statement(f), "truncated": True}
        else:
            rule, premises = w
            out = {"statement": self.statement(f), "rule": rule,
                   "rule_text": RULE_TEXT.get(rule, rule),
                   "premises": [self.derivation(p, depth + 1) for p in premises]}
        self._derivations[f] = out
        return out

    def evidence(self, f: Fact) -> list[str]:
        """Asserted edge ids a fact ultimately rests on."""
        out, seen, stack = [], set(), [f]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            w = self.why.get(cur)
            if isinstance(w, str):
                out.append(w)
            elif w:
                stack.extend(w[1])
        return out

    def fact_json(self, f: Fact, from_node: str | None = None) -> dict[str, Any]:
        if from_node is None or f.p in vocab.SYMMETRIC:
            direction = "symmetric" if f.p in vocab.SYMMETRIC else "forward"
        else:
            direction = "forward" if f.s == from_node else "backward"
        out: dict[str, Any] = {
            "source": f.s, "relation": f.p, "target": f.o,
            "source_label": self.label(f.s), "target_label": self.label(f.o),
            "statement": self.statement(f), "direction": direction,
            "inferred": self.is_inferred(f),
        }
        if out["inferred"]:
            out["derivation"] = self.derivation(f)
        else:
            e = self.edges.get(self.why[f], {})
            out["edge_id"] = e.get("id")
            out["sources"] = e.get("sources") or []
            for key in ("original_label", "wikidata"):
                if e.get(key):
                    out[key] = e[key]
        out["evidence_edge_ids"] = self.evidence(f)
        return out

    # ── Path search ──────────────────────────────────────────────────────

    def _neighbours(self, node: str, allowed: set[str] | None, directed: bool,
                    reverse: bool = False) -> Iterable[str]:
        for nb, facts in self.adj.get(node, {}).items():
            if any(self._usable(f, node, allowed, directed, reverse) for f in facts):
                yield nb

    @staticmethod
    def _usable(f: Fact, node: str, allowed, directed, reverse=False) -> bool:
        if allowed is not None and f.p not in allowed:
            return False
        if not directed or f.p in vocab.SYMMETRIC:
            return True
        return f.o == node if reverse else f.s == node

    def paths(self, sources: list[str], targets: list[str], max_hops: int = 4,
              max_paths: int = 5, relations: list[str] | None = None,
              directed: bool = False) -> dict[str, Any]:
        max_hops = max(1, min(max_hops, MAX_HOPS))
        max_paths = max(1, min(max_paths, MAX_PATHS))
        allowed = set(relations) if relations else None
        target_set = set(targets)

        # Distance to the nearest target bounds how far a partial path can go.
        dist = {t: 0 for t in target_set}
        queue = deque(target_set)
        while queue:
            cur = queue.popleft()
            if dist[cur] >= max_hops:
                continue
            for nb in self._neighbours(cur, allowed, directed, reverse=True):
                if nb not in dist:
                    dist[nb] = dist[cur] + 1
                    queue.append(nb)

        found: list[list[str]] = []
        expansions = 0
        truncated = False
        queue = deque([s] for s in sources if s in dist and s not in target_set)
        # Collect more than asked for so ranking can prefer cleaner paths.
        want = max_paths * 4
        while queue and len(found) < want:
            path = queue.popleft()
            cur = path[-1]
            for nb in self._neighbours(cur, allowed, directed):
                # Hops after stepping to nb = len(path); then dist[nb] more to a target.
                if nb in path or nb not in dist or len(path) + dist[nb] > max_hops:
                    continue
                expansions += 1
                if expansions > MAX_EXPANSIONS:
                    truncated = True
                    queue.clear()
                    break
                if nb in target_set:
                    found.append(path + [nb])
                else:
                    queue.append(path + [nb])

        built = [self._build_path(p, allowed, directed) for p in found]
        built.sort(key=lambda p: (p["hops"], p["inferred_steps"], p["backward_steps"]))
        return {"paths": built[:max_paths], "truncated": truncated or len(found) >= want}

    def _build_path(self, nodes: list[str], allowed, directed) -> dict[str, Any]:
        steps, text, evidence, sources = [], [self.label(nodes[0])], [], {}
        inferred_steps = backward_steps = 0
        for u, v in zip(nodes, nodes[1:]):
            facts = [f for f in self.adj[u][v] if self._usable(f, u, allowed, directed)]
            rendered = [self.fact_json(f, u) for f in facts]
            # Asserted before inferred, forward before backward.
            rendered.sort(key=lambda x: (x["inferred"], x["direction"] == "backward", x["relation"]))
            best = rendered[0]
            inferred_steps += best["inferred"]
            backward_steps += best["direction"] == "backward"
            arrow = {"forward": f"—{best['relation']}→", "backward": f"←{best['relation']}—",
                     "symmetric": f"—{best['relation']}—"}[best["direction"]]
            if best["inferred"]:
                arrow = arrow.replace("—", "┄")
            text.append(f"{arrow} {self.label(v)}")
            for r in rendered:
                for eid in r["evidence_edge_ids"]:
                    if eid not in evidence:
                        evidence.append(eid)
            steps.append({"from": u, "to": v, "facts": rendered})
        for eid in evidence:
            for s in self.edges.get(eid, {}).get("sources") or []:
                sources[s["id"]] = s
        evidence_nodes = list(dict.fromkeys(
            nodes + [x for eid in evidence for x in (self.edges[eid]["source"], self.edges[eid]["target"])]))
        return {
            "nodes": nodes,
            "labels": [self.label(n) for n in nodes],
            "hops": len(nodes) - 1,
            "text": " ".join(text),
            "steps": steps,
            "inferred_steps": inferred_steps,
            "backward_steps": backward_steps,
            "evidence_edge_ids": evidence,
            "evidence_node_ids": evidence_nodes,
            "sources": list(sources.values()),
        }

    # ── Facts about a node ───────────────────────────────────────────────

    def facts_about(self, node_ids: list[str], relation: str | None = None,
                    direction: str = "both", limit: int = 100) -> list[dict[str, Any]]:
        out, seen = [], set()
        for nid in node_ids:
            for f in self.by_node.get(nid, ()):
                if f in seen or (relation and f.p != relation):
                    continue
                if direction == "out" and f.s != nid and f.p not in vocab.SYMMETRIC:
                    continue
                if direction == "in" and f.o != nid and f.p not in vocab.SYMMETRIC:
                    continue
                seen.add(f)
                out.append(self.fact_json(f, nid))
        out.sort(key=lambda x: (x["inferred"], x["direction"] == "backward", x["relation"], x["statement"]))
        return out[:limit]


def find_paths(graph: dict[str, Any], source: str, target: str, max_hops: int = 4,
               max_paths: int = 5, relations: list[str] | None = None,
               directed: bool = False, include_inferred: bool = True) -> dict[str, Any]:
    ex = Explorer(graph, include_inferred)
    src, tgt = ex.resolve(source), ex.resolve(target)
    match = lambda ids: [{"id": i, "label": ex.label(i)} for i in ids]
    result = {"source_matches": match(src), "target_matches": match(tgt), "paths": [], "truncated": False}
    if src and tgt:
        result.update(ex.paths(src, tgt, max_hops, max_paths, relations, directed))
    return result


def node_facts(graph: dict[str, Any], node: str, relation: str | None = None,
               direction: str = "both", include_inferred: bool = True) -> dict[str, Any]:
    ex = Explorer(graph, include_inferred)
    ids = ex.resolve(node)
    return {"matches": [{"id": i, "label": ex.label(i)} for i in ids],
            "facts": ex.facts_about(ids, relation, direction) if ids else []}

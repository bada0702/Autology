"""경로 탐색·근거 테스트. 네트워크·LLM 없음.

실행:
    cd backend && ./venv/Scripts/python tests/test_explore.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from explore import Explorer, find_paths, node_facts  # noqa: E402
from knowledge import KnowledgeBase  # noqa: E402


def _n(nid, label, ntype="Instance", **kw):
    return {"id": nid, "label": label, "type": ntype, **kw}


def _e(eid, s, t, label, **kw):
    return {"id": eid, "source": s, "target": t, "label": label, **kw}


CAR = {
    "nodes": [_n("p", "피스톤"), _n("e", "엔진"), _n("c", "자동차"), _n("t", "테슬라"),
              _n("w", "바퀴"), _n("k", "부품", "Class"), _n("m", "엔진 부품", "Class")],
    "edges": [_e("e1", "p", "e", "part-of"), _e("e2", "e", "c", "part-of"),
              _e("e3", "t", "c", "produces"), _e("e4", "w", "c", "part-of"),
              _e("e5", "p", "m", "is-a"), _e("e6", "m", "k", "is-a")],
}


def test_resolve_by_label_alias_and_wikidata():
    g = {"nodes": [_n("a", "Tesla, Inc.", aliases=["테슬라"], wikidata_id="Q478214"), _n("b", "엔진")],
         "edges": []}
    ex = Explorer(g)
    assert ex.resolve("테슬라") == ["a"]
    assert ex.resolve("tesla,  inc.") == ["a"]
    assert ex.resolve("Q478214") == ["a"]
    assert ex.resolve("엔") == ["b"]          # substring fallback
    assert ex.resolve("b") == ["b"]           # id
    assert ex.resolve("없음") == []


def test_inferred_shortcut_comes_first_with_derivation():
    r = find_paths(CAR, "피스톤", "자동차", max_paths=5)
    texts = [p["text"] for p in r["paths"]]
    # 1-hop path exists only through inference (prp-trp); it is still found first by length
    one_hop = r["paths"][0]
    assert one_hop["hops"] == 1 and one_hop["inferred_steps"] == 1, texts
    fact = one_hop["steps"][0]["facts"][0]
    assert fact["inferred"] and fact["derivation"]["rule"] == "prp-trp"
    leaves = [p["statement"] for p in fact["derivation"]["premises"]]
    assert leaves == ["피스톤 part-of 엔진", "엔진 part-of 자동차"]
    # evidence = the asserted edges, and the intermediate node for highlighting
    assert set(one_hop["evidence_edge_ids"]) == {"e1", "e2"}
    assert "e" in one_hop["evidence_node_ids"]
    # the asserted 2-hop path is also there
    assert "피스톤 —part-of→ 엔진 —part-of→ 자동차" in texts, texts


def test_backward_steps_and_asserted_only():
    r = find_paths(CAR, "피스톤", "테슬라", include_inferred=False)
    assert r["paths"], r
    best = r["paths"][0]
    assert best["text"] == "피스톤 —part-of→ 엔진 —part-of→ 자동차 ←produces— 테슬라"
    assert best["backward_steps"] == 1 and best["inferred_steps"] == 0
    assert best["evidence_edge_ids"] == ["e1", "e2", "e3"]


def test_directed_and_relation_filter():
    # Directed: no forward path from 자동차 to 피스톤
    assert find_paths(CAR, "자동차", "피스톤", directed=True)["paths"] == []
    assert find_paths(CAR, "피스톤", "자동차", directed=True)["paths"]
    # Only produces: 피스톤 is unreachable from 테슬라
    assert find_paths(CAR, "테슬라", "피스톤", relations=["produces"])["paths"] == []


def test_max_hops_bounds_paths():
    r = find_paths(CAR, "바퀴", "테슬라", max_hops=1, include_inferred=False)
    assert r["paths"] == []
    r = find_paths(CAR, "바퀴", "테슬라", max_hops=2, include_inferred=False)
    assert [p["hops"] for p in r["paths"]] == [2]


def test_type_inheritance_is_explained():
    r = node_facts(CAR, "피스톤", relation="rdf:type", direction="out")
    by_target = {f["target_label"]: f for f in r["facts"]}
    assert set(by_target) == {"엔진 부품", "부품"}
    assert not by_target["엔진 부품"]["inferred"]
    d = by_target["부품"]["derivation"]
    assert d["rule"] == "cax-sco"
    assert [p["statement"] for p in d["premises"]] == ["피스톤 rdf:type 엔진 부품",
                                                        "엔진 부품 rdfs:subClassOf 부품"]


def test_unknown_endpoints_report_no_matches():
    r = find_paths(CAR, "없는노드", "자동차")
    assert r["source_matches"] == [] and r["paths"] == []
    assert r["target_matches"][0]["label"] == "자동차"


def test_dense_graph_stays_bounded():
    # Complete-ish graph: enumeration must stop at the expansion cap or path limit.
    n = 40
    nodes = [_n(f"x{i}", f"노드{i}") for i in range(n)]
    edges = [_e(f"e{i}_{j}", f"x{i}", f"x{j}", "related-to")
             for i in range(n) for j in range(i + 1, n)]
    r = find_paths({"nodes": nodes, "edges": edges}, "노드0", "노드39", max_hops=4, max_paths=5)
    assert len(r["paths"]) == 5 and r["paths"][0]["hops"] == 1


def test_symmetric_relation_reads_both_ways():
    g = {"nodes": [_n("a", "A"), _n("b", "B")], "edges": [_e("e1", "a", "b", "related-to")]}
    r = find_paths(g, "B", "A", directed=True)
    assert r["paths"] and r["paths"][0]["steps"][0]["facts"][0]["direction"] == "symmetric"


def test_provenance_from_knowledge_base():
    kb = KnowledgeBase(os.path.join(tempfile.mkdtemp(), "kb.db"))
    kb.ingest({"nodes": [_n("1", "피스톤"), _n("2", "엔진")],
               "edges": [_e("a", "1", "2", "part-of")]}, "엔진 구조")
    kb.ingest({"nodes": [_n("1", "엔진"), _n("2", "자동차")],
               "edges": [_e("a", "1", "2", "part-of")]}, "자동차")
    r = find_paths(kb.graph(), "피스톤", "자동차")
    inferred = r["paths"][0]
    assert inferred["hops"] == 1
    assert sorted(s["topic"] for s in inferred["sources"]) == ["엔진 구조", "자동차"]
    leaves = inferred["steps"][0]["facts"][0]["derivation"]["premises"]
    assert [l["sources"][0]["topic"] for l in leaves] == ["엔진 구조", "자동차"]


def _run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL  {t.__name__}: {exc!r}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return failures


if __name__ == "__main__":
    sys.exit(1 if _run_all() else 0)

"""자동 수정 루프 테스트. 네트워크·LLM 없음.

실행:
    cd backend && ./venv/Scripts/python tests/test_repair.py
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from repair import not_worse, quality, repair_graph  # noqa: E402
from reasoning import analyze  # noqa: E402


def _n(nid, label, ntype="Instance"):
    return {"id": nid, "label": label, "type": ntype}


def _e(eid, s, t, label):
    return {"id": eid, "source": s, "target": t, "label": label}


def _chat(choice, reason="이유"):
    calls = []

    async def chat(system, user):
        calls.append(user)
        value = choice(user) if callable(choice) else choice
        return json.dumps({"reason": reason, "choice": value}, ensure_ascii=False)
    chat.calls = calls
    return chat


def _run(graph, chat=None, **kw):
    return asyncio.run(repair_graph(graph, chat, "테스트", **kw))


def _pick(wrong):
    """Fake model that names the statement containing `wrong`."""
    def choose(user):
        for line in user.splitlines():
            if wrong in line and ") " in line:
                return int(line.split(")", 1)[0])
        return 0
    return choose


CYCLE = {"nodes": [_n("h", "심장"), _n("c", "순환계"), _n("b", "인체")],
         "edges": [_e("e1", "h", "c", "part-of"), _e("e2", "c", "h", "part-of"), _e("e3", "c", "b", "part-of")]}
DISJOINT = {"nodes": [_n("r", "참새"), _n("a", "조류", "Class"), _n("m", "포유류", "Class")],
            "edges": [_e("e1", "r", "a", "rdf:type"), _e("e2", "r", "m", "rdf:type"),
                      _e("e3", "a", "m", "owl:disjointWith")]}


def test_clean_graph_is_untouched():
    g = {"nodes": [_n("a", "A"), _n("b", "B")], "edges": [_e("e1", "a", "b", "part-of")]}
    chat = _chat(1)
    r = _run(g, chat)
    assert r["actions"] == [] and chat.calls == [] and len(g["edges"]) == 1
    assert r["before"] == r["after"] == {"score": 100, "errors": 0, "warnings": 0}


def test_rule_fix_needs_no_llm():
    g = {"nodes": [_n("x", "렉스"), _n("d", "개")],
         "edges": [_e("e1", "x", "d", "rdf:type"), _e("e2", "x", "ghost", "part-of")]}
    r = _run(g)
    assert {a["kind"] for a in r["actions"]} == {"promote_to_class", "remove_dangling_edge"}
    assert next(n for n in g["nodes"] if n["id"] == "d")["type"] == "Class"
    assert [(e["id"], e["label"]) for e in g["edges"]] == [("e1", "rdf:type")]    # downgrade undone
    assert r["after"]["errors"] == 0 and r["removed_edges"][0]["id"] == "e2"


def test_literal_property_is_reversed():
    g = {"nodes": [_n("v", "빨강", "Literal"), _n("a", "사과")],
         "edges": [_e("e1", "v", "a", "has-property")]}
    r = _run(g)
    assert (g["edges"][0]["source"], g["edges"][0]["target"]) == ("a", "v")
    assert r["after"]["warnings"] == 0


def test_llm_removes_the_false_statement_of_a_cycle():
    g = json.loads(json.dumps(CYCLE))
    r = _run(g, _chat(_pick("순환계 part-of 심장")))
    assert sorted(e["id"] for e in g["edges"]) == ["e1", "e3"]
    assert r["before"]["errors"] == 1 and r["after"]["errors"] == 0
    assert r["actions"][0]["by"] == "llm" and r["removed_edges"][0]["id"] == "e2"
    assert r["unresolved"] == []


def test_disjoint_violation_offers_its_evidence():
    g = json.loads(json.dumps(DISJOINT))
    chat = _chat(_pick("참새 rdf:type 포유류"))
    r = _run(g, chat)
    assert all(s in chat.calls[0] for s in ("참새 rdf:type 조류", "참새 rdf:type 포유류"))
    assert sorted(e["id"] for e in g["edges"]) == ["e1", "e3"] and r["after"]["errors"] == 0


def test_inherited_disjoint_violation_traces_to_asserted_edges():
    g = {"nodes": [_n("x", "렉스"), _n("d", "개", "Class"), _n("a", "동물", "Class"), _n("p", "식물", "Class")],
         "edges": [_e("e1", "x", "d", "rdf:type"), _e("e2", "d", "a", "rdfs:subClassOf"),
                   _e("e3", "x", "p", "rdf:type"), _e("e4", "a", "p", "owl:disjointWith")]}
    chat = _chat(_pick("렉스 rdf:type 식물"))
    r = _run(g, chat)
    assert "개 rdfs:subClassOf 동물" in chat.calls[0]
    assert "e3" not in [e["id"] for e in g["edges"]] and r["after"]["errors"] == 0


def test_cannot_tell_changes_nothing():
    g = json.loads(json.dumps(CYCLE))
    r = _run(g, _chat(0))
    assert len(g["edges"]) == 3 and r["actions"] == [] and len(r["unresolved"]) == 1


def test_out_of_range_choice_changes_nothing():
    g = json.loads(json.dumps(CYCLE))
    _run(g, _chat(9))
    assert len(g["edges"]) == 3


def test_removal_that_does_not_help_is_rolled_back():
    # A⇄B⇄C is one cycle error. Removing A→B leaves B⇄C: still one error, so
    # the score does not improve and the edge must come back.
    g = {"nodes": [_n("a", "A"), _n("b", "B"), _n("c", "C")],
         "edges": [_e("e1", "a", "b", "part-of"), _e("e2", "b", "a", "part-of"),
                   _e("e3", "b", "c", "part-of"), _e("e4", "c", "b", "part-of")]}
    r = _run(g, _chat(_pick("A part-of B")))
    assert [x["statement"] for x in r["rejected"]] == ["A part-of B"]
    assert len(g["edges"]) == 4 and r["removed_edges"] == [] and r["after"] == r["before"]


def test_removals_are_capped():
    nodes, edges = [], []
    for i in range(6):                        # six separate 2-cycles, twelve edges
        nodes += [_n(f"a{i}", f"A{i}"), _n(f"b{i}", f"B{i}")]
        edges += [_e(f"f{i}", f"a{i}", f"b{i}", "part-of"), _e(f"r{i}", f"b{i}", f"a{i}", "part-of")]
    g = {"nodes": nodes, "edges": edges}
    r = _run(g, _chat(1))
    assert len(r["removed_edges"]) == 2       # 20% of 12 edges
    assert len(g["edges"]) == 10 and len(g["nodes"]) == 12 and r["unresolved"]


def test_llm_failure_is_survived():
    async def broken(system, user):
        raise RuntimeError("offline")
    g = json.loads(json.dumps(CYCLE))
    r = _run(g, broken)
    assert len(g["edges"]) == 3 and r["after"]["errors"] == 1


def test_nodes_are_never_deleted():
    g = json.loads(json.dumps(CYCLE))
    _run(g, _chat(1))
    assert len(g["nodes"]) == 3


def test_not_worse_guards_rewrites():
    good = {"nodes": [_n("a", "A"), _n("b", "B")], "edges": [_e("e1", "a", "b", "part-of")]}
    bad = {"nodes": good["nodes"], "edges": [_e("e1", "a", "b", "part-of"), _e("e2", "b", "a", "part-of")]}
    assert not_worse(bad, good) and not not_worse(good, bad)
    assert not not_worse(good, {"nodes": [], "edges": []})     # emptying a graph is not a fix


def test_quality_penalty_is_uncapped():
    nodes, edges = [], []
    for i in range(10):
        nodes += [_n(f"a{i}", f"A{i}"), _n(f"b{i}", f"B{i}")]
        edges += [_e(f"f{i}", f"a{i}", f"b{i}", "part-of"), _e(f"r{i}", f"b{i}", f"a{i}", "part-of")]
    q = quality({"nodes": nodes, "edges": edges})
    assert q["score"] == 0 and q["penalty"] == 150 and q["errors"] == 10


def test_report_matches_final_graph():
    g = json.loads(json.dumps(CYCLE))
    r = _run(g, _chat(_pick("순환계 part-of 심장")))
    assert r["after"]["errors"] == sum(1 for i in analyze(g)["issues"] if i["severity"] == "error")


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

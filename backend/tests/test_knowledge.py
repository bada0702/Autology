"""지식 베이스(누적·엔티티 병합·출처)와 엔티티 링킹 테스트. 네트워크·LLM 없음.

실행:
    cd backend && ./venv/Scripts/python tests/test_knowledge.py
"""
import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import entity_link as el  # noqa: E402
from knowledge import KnowledgeBase  # noqa: E402
from reasoning import analyze  # noqa: E402


def _n(nid, label, ntype="Instance", **kw):
    return {"id": nid, "label": label, "type": ntype, **kw}


def _e(eid, s, t, label):
    return {"id": eid, "source": s, "target": t, "label": label}


def _kb():
    return KnowledgeBase(os.path.join(tempfile.mkdtemp(), "kb.db"))


RUN1 = {  # "테슬라" generation
    "nodes": [_n("n1", "테슬라", wikidata_id="Q478214"), _n("n2", "일론 머스크"),
              _n("n3", "모델 3"), _n("n4", "전기자동차", "Class")],
    "edges": [_e("e1", "n2", "n1", "member of"), _e("e2", "n1", "n3", "produces"),
              _e("e3", "n3", "n4", "is-a")],
}
RUN2 = {  # "스페이스X" generation — same ids n1.. but different entities
    "nodes": [_n("n1", "Tesla, Inc.", wikidata_id="Q478214", description="전기차 회사"),
              _n("n2", "일론 머스크", properties=[{"key": "국적", "value": "미국"}]),
              _n("n3", "스페이스X"), _n("n4", "전기자동차", "Instance")],
    "edges": [_e("e1", "n2", "n3", "member of"), _e("e2", "n2", "n1", "member of")],
}


def test_first_ingest_adds_everything():
    kb = _kb()
    r = kb.ingest(RUN1, "테슬라")
    assert (r["nodes_added"], r["nodes_merged"], r["edges_added"]) == (4, 0, 3)
    assert kb.stats()["nodes"] == 4


def test_entity_resolution_across_runs():
    kb = _kb()
    kb.ingest(RUN1, "테슬라")
    r = kb.ingest(RUN2, "스페이스X")
    reasons = {m["label"]: m["reason"] for m in r["merges"]}
    assert reasons == {"Tesla, Inc.": "wikidata:Q478214", "일론 머스크": "label"}
    # 전기자동차 is a Class in run 1 and an Instance in run 2 → not merged
    assert r["nodes_added"] == 2
    # musk member-of tesla existed already; musk member-of spacex is new
    assert (r["edges_added"], r["edges_existing"]) == (1, 1)
    g = kb.graph()
    tesla = next(n for n in g["nodes"] if n.get("wikidata_id") == "Q478214")
    assert tesla["label"] == "테슬라" and "Tesla, Inc." in tesla["aliases"]
    assert tesla["description"] == "전기차 회사"              # filled from run 2
    musk = next(n for n in g["nodes"] if n["label"] == "일론 머스크")
    assert {s["topic"] for s in musk["sources"]} == {"테슬라", "스페이스X"}


def test_homonyms_with_different_wikidata_ids_stay_apart():
    kb = _kb()
    kb.ingest({"nodes": [_n("a", "수성", wikidata_id="Q308")], "edges": []}, "행성")
    r = kb.ingest({"nodes": [_n("a", "수성", wikidata_id="Q925")], "edges": []}, "원소")
    assert r["nodes_added"] == 1 and kb.stats()["nodes"] == 2


def test_wikidata_id_is_learned_on_label_merge():
    kb = _kb()
    kb.ingest({"nodes": [_n("a", "오스틴")], "edges": []}, "t1")
    kb.ingest({"nodes": [_n("a", "오스틴", wikidata_id="Q16559")], "edges": []}, "t2")
    r = kb.ingest({"nodes": [_n("a", "Austin, Texas", wikidata_id="Q16559")], "edges": []}, "t3")
    assert r["merges"][0]["reason"] == "wikidata:Q16559" and kb.stats()["nodes"] == 1


def test_property_conflicts_are_reported():
    kb = _kb()
    kb.ingest({"nodes": [_n("a", "X", properties=[{"key": "인구", "value": "100"}])], "edges": []}, "t1")
    r = kb.ingest({"nodes": [_n("a", "X", properties=[{"key": "인구", "value": "200"}])], "edges": []}, "t2")
    assert r["conflicts"] == [{"node": "X", "property": "인구", "existing": "100", "incoming": "200"}]


def test_delete_source_removes_only_its_contribution():
    kb = _kb()
    kb.ingest(RUN1, "테슬라")
    r2 = kb.ingest(RUN2, "스페이스X")
    removed = kb.delete_source(r2["source_id"])
    assert removed == {"nodes_deleted": 2, "edges_deleted": 1}   # 스페이스X, 전기자동차(Instance)
    assert kb.stats() == {"nodes": 4, "edges": 3, "sources": 1, "linked_nodes": 1}


def test_neighbourhood_and_search():
    kb = _kb()
    kb.ingest(RUN1, "테슬라")
    kb.ingest(RUN2, "스페이스X")
    seeds = [r["id"] for r in kb.search("스페이스")]
    sub = kb.neighbourhood(seeds, hops=1)
    assert {n["label"] for n in sub["nodes"]} == {"스페이스X", "일론 머스크"}
    sub2 = kb.neighbourhood(seeds, hops=2)
    assert "테슬라" in {n["label"] for n in sub2["nodes"]}
    assert kb.search("Q478214")[0]["label"] == "테슬라"


def test_accumulated_graph_supports_cross_run_reasoning():
    kb = _kb()
    kb.ingest({"nodes": [_n("a", "피스톤"), _n("b", "엔진")], "edges": [_e("1", "a", "b", "part-of")]}, "엔진")
    kb.ingest({"nodes": [_n("a", "엔진"), _n("b", "자동차")], "edges": [_e("1", "a", "b", "part-of")]}, "자동차")
    g = kb.graph()
    label = {n["id"]: n["label"] for n in g["nodes"]}
    inferred = {(label[e["source"]], label[e["target"]]) for e in analyze(g)["inferred"]}
    assert ("피스톤", "자동차") in inferred      # needs facts from both generations


def test_edge_metadata_survives_storage():
    kb = _kb()
    g = {"nodes": [_n("a", "A"), _n("b", "B")], "edges": [_e("1", "a", "b", "본사 소재지")]}
    g["edges"][0].update(wikidata={"id": "P159", "label": {}, "transitive": False, "method": "exact"},
                         super_relation="located-in", super_inverse=False)
    kb.ingest(g, "t")
    (edge,) = kb.graph()["edges"]
    assert edge["wikidata"]["id"] == "P159" and edge["super_relation"] == "located-in"


# ── Entity linking ──────────────────────────────────────────────────────

def _fake_search(table):
    async def search(label, lang):
        return table.get((label, lang), [])
    return search


def _item(qid, label, desc, match_text=None):
    return {"id": qid, "label": label, "description": desc, "match": "label",
            "match_text": match_text or label}


def test_filter_candidates():
    # Search order as Wikidata returns it for "테슬라": exact labels first.
    items = [_item("Q3", "테슬라", "electric car company"),
             _item("Q1", "모델 3", "위키미디어 동음이의어 문서"),
             _item("Q5", "테슬라", "SI unit"),
             _item("Q4", "테슬라 모델 S", "electric sedan", match_text="테슬라 모델 S")]
    assert [c["id"] for c in el.filter_candidates("테슬라", items)] == ["Q3", "Q5"]   # no prefix matches
    assert [c["id"] for c in el.filter_candidates("모델 3", items[1:2])] == []      # disambig dropped
    # "아마존": search ranks the company (label 아마존닷컴) first, the only exact
    # label is a chess piece. The top hit must survive the exact-label filter.
    amazon = [_item("Q3884", "아마존닷컴", "미국 시애틀의 기업"),
              _item("Q647433", "아마존", "fairy chess piece"),
              _item("Q177567", "아마존 우림", "열대 우림")]
    assert [c["id"] for c in el.filter_candidates("아마존", amazon)] == ["Q647433", "Q3884"]


def test_pick_by_number_or_listed_id():
    cands = [_item("Q1", "a", ""), _item("Q2", "b", "")]
    assert el._pick({"choice": 2}, cands)["id"] == "Q2"
    assert el._pick({"choice": "1"}, cands)["id"] == "Q1"
    assert el._pick({"choice": 0}, cands) is None
    assert el._pick({"choice": 3}, cands) is None
    assert el._pick({"id": "Q2"}, cands)["id"] == "Q2"        # old format still understood
    assert el._pick({"id": "Q9"}, cands) is None              # never an unlisted id
    assert el._pick({"choice": True}, cands) is None


def test_link_entities_accepts_only_listed_candidates():
    table = {("테슬라", "ko"): [_item("Q478214", "테슬라", "전기자동차 회사"), _item("Q163343", "테슬라", "SI unit")],
             ("일론 머스크", "ko"): [_item("Q317521", "일론 머스크", "사업가")]}
    answers = {"테슬라": 1, "일론 머스크": 7}      # second is out of range

    async def chat(system, user):
        label = user.split('Node: "', 1)[1].split('"', 1)[0]
        return json.dumps({"choice": answers[label]})
    g = {"nodes": [_n("a", "테슬라"), _n("b", "일론 머스크"), _n("c", "42", "Literal")], "edges": []}
    summary = asyncio.run(el.link_entities(g, chat, "전기차", search=_fake_search(table)))
    assert summary["linked"] == {"테슬라": "Q478214"}
    assert g["nodes"][0]["wikidata_id"] == "Q478214" and "wikidata_id" not in g["nodes"][1]
    assert "42" not in summary["unlinked"]                      # literals are not linked


def test_link_entities_survives_failures():
    async def broken_search(label, lang):
        raise RuntimeError("offline")

    async def chat(system, user):
        raise AssertionError("must not be called without candidates")
    g = {"nodes": [_n("a", "테슬라")], "edges": []}
    summary = asyncio.run(el.link_entities(g, chat, search=broken_search))
    assert summary["linked"] == {} and summary["unlinked"] == ["테슬라"]


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

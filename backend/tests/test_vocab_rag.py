"""Wikidata 관계 사전 RAG 테스트 (임베딩·LLM 없이 결정적으로 실행).

실행:
    cd backend && ./venv/Scripts/python tests/test_vocab_rag.py
"""
import asyncio
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import vocab_rag as rag  # noqa: E402
import vocabulary as vocab  # noqa: E402
from reasoning import analyze  # noqa: E402
from semantic import graph_to_rdf  # noqa: E402


def _n(nid, label, ntype="Instance"):
    return {"id": nid, "label": label, "type": ntype}


def _e(eid, s, t, label):
    return {"id": eid, "source": s, "target": t, "label": label}


def _link(graph, chat=None):
    vocab.normalize_graph(graph)
    summary = asyncio.run(rag.link_relations(graph, chat, use_embeddings=False))
    vocab.normalize_graph(graph)
    return summary


def _fake_chat(answer, verify="a", meaning="yes", vote_same=True):
    """Fake LLM. `answer` handles selection and the other checks answer `verify`
    (direction) and `meaning`; query expansion finds nothing. A numbered pick
    means the same option when the list is asked again in reverse order, unless
    `vote_same` is False."""
    calls = []
    first_pick: dict[str, str] = {}

    async def chat(system, user):
        calls.append(user)
        if "statements" in system:
            return json.dumps({"reason": "", "answer": verify})
        if "terms" in system:
            return json.dumps({"terms": []})
        if "proposed Wikidata property" in system:
            return json.dumps({"reason": "", "answer": meaning})
        result = dict(answer(user) if callable(answer) else answer)
        choice = result.get("choice")
        options = [x for x in user.splitlines() if x[:1].isdigit() and not x.startswith("0)")]
        relation = user.splitlines()[0]
        if isinstance(choice, int) and 1 <= choice <= len(options):
            if relation not in first_pick:
                first_pick[relation] = options[choice - 1].split(") ", 1)[1]
            elif vote_same:
                result["choice"] = next(i for i, x in enumerate(options, 1)
                                        if x.split(") ", 1)[1] == first_pick[relation])
            else:
                result["choice"] = 0
        return json.dumps(result)
    chat.calls = calls
    return chat


def _inherited_pid(core):
    """A property mapped to `core` only through the P1647 chain."""
    for pid in rag.load_properties():
        m = rag.core_mapping(pid)
        if m and m[0] == core and not m[2]:
            return pid
    raise AssertionError(f"no inherited property for {core}")


def test_dictionary_loaded():
    props = rag.load_properties()
    assert len(props) > 1500
    assert props["P176"]["label"]["en"] == "manufacturer"


def test_core_mapping_exact_and_inherited():
    assert rag.core_mapping("P527") == ("part-of", True, True)
    assert rag.core_mapping("P131") == ("located-in", False, True)
    pid = _inherited_pid("part-of")
    rel, _, exact = rag.core_mapping(pid)
    assert rel == "part-of" and not exact


def test_lexical_search_korean_and_english():
    assert rag.search("제조사", 3, use_embeddings=False)[0]["id"] == "P176"
    assert rag.search("manufacturer", 3, use_embeddings=False)[0]["id"] == "P176"
    assert "P50" in [c["id"] for c in rag.search("written by", 3, use_embeddings=False)]
    assert rag.search("공식 언어", 3, use_embeddings=False)[0]["id"] == "P37"


def test_exact_match_links_and_rewrites_to_core():
    g = {"nodes": [_n("phone", "아이폰"), _n("apple", "애플")],
         "edges": [_e("e1", "phone", "apple", "제조사")]}
    summary = _link(g)
    assert summary["linked"]["제조사"] == {"id": "P176", "method": "exact"}
    (edge,) = g["edges"]
    # P176 manufacturer ≡ inverse of produces → 애플 produces 아이폰
    assert (edge["source"], edge["label"], edge["target"]) == ("apple", "produces", "phone")
    assert edge["original_label"] == "제조사" and edge["wikidata"]["id"] == "P176"


def test_llm_choice_is_restricted_to_candidates():
    g = {"nodes": [_n("a", "A"), _n("b", "B")],
         "edges": [_e("e1", "a", "b", "연비에 영향"), _e("e2", "b", "a", "아주 특이한 관계")]}
    chat = _fake_chat({"choice": 99})                 # out of range for every relation
    summary = _link(g, chat)
    assert len(chat.calls) == 4                       # expand + select per relation, no verification
    assert set(summary["unlinked"]) == {"연비에 영향", "아주 특이한 관계"}
    assert all("wikidata" not in e for e in g["edges"])


def test_llm_choice_by_number_maps_to_candidate():
    g = {"nodes": [_n("a", "A"), _n("b", "B")],
         "edges": [_e("e1", "a", "b", "학교를 졸업함"), _e("e2", "b", "a", "아주 특이한 관계")]}
    chat = _fake_chat(lambda user: {"choice": 2 if "학교를 졸업함" in user else 0})
    summary = _link(g, chat)
    prompt = next(c for c in chat.calls if "학교를 졸업함" in c and "Options:" in c)
    lines = prompt.splitlines()
    assert any(x.startswith("2) ") for x in lines) and "0) none of these" in lines
    assert not any(line.startswith("1) P") for line in prompt.splitlines())   # no ids to copy
    second = rag.with_inverses(rag.search("학교를 졸업함", 5, use_embeddings=False))[1]["id"]
    assert summary["linked"]["학교를 졸업함"]["id"] == second
    assert summary["unlinked"] == ["아주 특이한 관계"]


def test_llm_choice_links_candidate():
    g = {"nodes": [_n("a", "A"), _n("b", "B")], "edges": [_e("e1", "a", "b", "학교를 졸업함")]}

    chat = _fake_chat({"choice": 1})
    summary = _link(g, chat)
    assert len(chat.calls) == 5                       # expand, select, second vote, meaning, direction
    assert summary["linked"]["학교를 졸업함"]["method"] == "llm"
    assert g["edges"][0]["wikidata"]["id"] == summary["linked"]["학교를 졸업함"]["id"]


def test_verification_rejects_links():
    g = {"nodes": [_n("phone", "아이폰"), _n("apple", "애플"), _n("a", "A"), _n("b", "B")],
         "edges": [_e("e1", "phone", "apple", "제조사"), _e("e2", "a", "b", "학교를 졸업함")]}

    # 제조사 is an exact match, so 학교를 졸업함 is the only (first) relation asked.
    summary = _link(g, _fake_chat({"choice": 1}, verify="none"))
    assert summary["linked"] == {}                     # exact matches are verified too
    assert set(summary["rejected"]) == {"제조사", "학교를 졸업함"}
    assert all("wikidata" not in e for e in g["edges"])


def test_verification_rejects_reversed_llm_link_without_flipping():
    # The verifier says the model's pick reads backwards. Inverse properties are
    # already offered at selection, so the link is dropped rather than switched.
    g = {"nodes": [_n("phone", "아이폰"), _n("apple", "애플")],
         "edges": [_e("e1", "apple", "phone", "제조한 회사")]}
    summary = _link(g, _fake_chat({"choice": "P176"}, verify="b"))
    assert summary["linked"] == {} and summary["rejected"] == {"제조한 회사": "P176"}
    assert "wikidata" not in g["edges"][0]


def test_expansion_retrieves_english_names():
    # "부인" has no spouse candidate by itself; the English name brings it in.
    g = {"nodes": [_n("a", "찰스"), _n("b", "에마")], "edges": [_e("e1", "a", "b", "부인")]}
    assert "P26" not in {c["id"] for c in rag.with_inverses(rag.search("부인", 5, use_embeddings=False))}
    calls = []

    async def chat(system, user):
        calls.append(user)
        if "terms" in system:
            return json.dumps({"terms": ["spouse"]})
        if "statements" in system:
            return json.dumps({"reason": "", "answer": "a"})
        if "proposed Wikidata property" in system:
            return json.dumps({"reason": "", "answer": "yes"})
        return json.dumps({"choice": "P26"})
    summary = _link(g, chat)
    assert summary["linked"]["부인"] == {"id": "P26", "method": "llm"}


def test_expansion_failure_keeps_the_phrase_candidates():
    g = {"nodes": [_n("a", "A"), _n("b", "B")], "edges": [_e("e1", "a", "b", "학교를 졸업함")]}
    first = rag.with_inverses(rag.search("학교를 졸업함", 5, use_embeddings=False))[0]["id"]

    async def chat(system, user):
        if "terms" in system:
            raise RuntimeError("timeout")
        if "statements" in system:
            return json.dumps({"reason": "", "answer": "a"})
        if "proposed Wikidata property" in system:
            return json.dumps({"reason": "", "answer": "yes"})
        return json.dumps({"choice": first})
    assert "학교를 졸업함" in _link(g, chat)["linked"]


def test_symmetric_property_passes_either_direction():
    pid = next(p for p, v in rag.load_properties().items() if v.get("symmetric"))
    label = "아주 드문 인접 표현"
    g = {"nodes": [_n("a", "A"), _n("b", "B")], "edges": [_e("e1", "a", "b", label)]}

    async def chat(system, user):
        if "terms" in system:
            return json.dumps({"terms": [rag.load_properties()[pid]["label"]["en"]]})
        if "statements" in system:
            return json.dumps({"reason": "", "answer": "b"})
        if "proposed Wikidata property" in system:
            return json.dumps({"reason": "", "answer": "yes"})
        return json.dumps({"choice": pid})
    assert _link(g, chat)["linked"][label]["id"] == pid


def test_comparative_phrases_are_never_linked():
    g = {"nodes": [_n("a", "민수"), _n("b", "지훈")],
         "edges": [_e("e1", "a", "b", "보다 키가 큼"), _e("e2", "b", "a", "taller than")]}
    chat = _fake_chat({"choice": 1})
    summary = _link(g, chat)
    assert summary["linked"] == {} and chat.calls == []


def test_measured_order_properties_are_not_offered():
    g = {"nodes": [_n("a", "A"), _n("b", "B")], "edges": [_e("e1", "a", "b", "더 큼")]}
    seen = []

    async def chat(system, user):
        if "terms" in system:
            return json.dumps({"terms": ["greater than"]})
        seen.append(user)
        return json.dumps({"choice": 0})
    _link(g, chat)
    assert seen and not any("greater than" in x.lower() for x in seen)


def test_pick_must_survive_a_reordered_second_vote():
    g = {"nodes": [_n("a", "A"), _n("b", "B")], "edges": [_e("e1", "a", "b", "학교를 졸업함")]}
    summary = _link(g, _fake_chat({"choice": 1}, vote_same=False))
    assert summary["linked"] == {} and summary["rejected_by"] == {"학교를 졸업함": ["vote"]}
    assert "wikidata" not in g["edges"][0]


def test_pick_must_mean_the_same_as_the_phrase():
    g = {"nodes": [_n("a", "A"), _n("b", "B")], "edges": [_e("e1", "a", "b", "학교를 졸업함")]}
    summary = _link(g, _fake_chat({"choice": 1}, meaning="no"))
    assert summary["linked"] == {} and summary["rejected_by"] == {"학교를 졸업함": ["meaning"]}


def test_meaning_check_does_not_apply_to_exact_matches():
    g = {"nodes": [_n("phone", "아이폰"), _n("apple", "애플")],
         "edges": [_e("e1", "phone", "apple", "제조사")]}
    assert _link(g, _fake_chat({}, meaning="no"))["linked"]["제조사"]["method"] == "exact"



def test_verification_never_flips_exact_matches():
    # "대한민국 수도 서울": the phrase is P36's own name, so it reads in P36's
    # direction. Small models answered "b" here and turned a correct link into
    # P1376 (capital of); an exact match may be rejected, never flipped.
    g = {"nodes": [_n("kr", "대한민국"), _n("seoul", "서울")],
         "edges": [_e("e1", "kr", "seoul", "수도")]}
    summary = _link(g, _fake_chat({}, verify="b"))
    assert summary["linked"]["수도"] == {"id": "P36", "method": "exact"}
    (edge,) = g["edges"]
    assert edge["wikidata"]["id"] == "P36" and (edge["source"], edge["target"]) == ("kr", "seoul")


def test_inverse_properties_are_offered():
    cands = rag.with_inverses(rag.search("manufacturer", 1, use_embeddings=False))
    ids = {c["id"]: c for c in cands}
    assert "P176" in ids and "P1056" in ids and ids["P1056"]["inverse_of"] == "P176"


def test_subproperty_link_enables_reasoning():
    pid = _inherited_pid("part-of")
    _, inverse, _ = rag.core_mapping(pid)
    g = {"nodes": [_n("x", "X"), _n("y", "Y"), _n("z", "Z")],
         "edges": [_e("e1", "x", "y", "특수 구성 관계"), _e("e2", "y", "z", "part-of")]}
    vocab.normalize_graph(g)
    rag._apply_link(g["edges"][0], rag.load_properties()[pid], "llm")
    assert g["edges"][0]["super_relation"] == "part-of"
    vocab.normalize_graph(g)                          # must keep the link
    assert g["edges"][0]["relation"] == vocab.CUSTOM and g["edges"][0]["super_relation"] == "part-of"

    triples = {(e["source"], e["label"], e["target"], e["rule"]) for e in analyze(g)["inferred"]}
    if not inverse:
        assert ("x", "part-of", "y", "prp-spo1") in triples
        assert ("x", "part-of", "z", "prp-trp") in triples
    else:
        assert ("y", "part-of", "x", "prp-spo1") in triples


def test_wikidata_transitive_property_is_used():
    g = {"nodes": [_n("a", "A"), _n("b", "B"), _n("c", "C")],
         "edges": [_e("e1", "a", "b", "계승"), _e("e2", "b", "c", "계승")]}
    vocab.normalize_graph(g)
    for e in g["edges"]:
        e["wikidata"] = {"id": "P0", "label": {}, "transitive": True, "method": "llm"}
    t = {(e["source"], e["label"], e["target"]) for e in analyze(g)["inferred"]}
    assert ("a", "계승", "c") in t


def test_rdf_export_of_linked_relations():
    from rdflib import OWL, RDF, RDFS, URIRef
    from rdflib.namespace import SKOS
    pid = _inherited_pid("part-of")
    g = {"nodes": [_n("x", "X"), _n("y", "Y")], "edges": [_e("e1", "x", "y", "특수 구성 관계")]}
    vocab.normalize_graph(g)
    rag._apply_link(g["edges"][0], rag.load_properties()[pid], "llm")
    rdf = graph_to_rdf(g)
    pred = next(rdf.subjects(SKOS.exactMatch, URIRef("http://www.wikidata.org/entity/" + pid)))
    sup = next(rdf.objects(pred, RDFS.subPropertyOf))
    part_of = URIRef("http://autology.local/ontology#part-of")
    assert sup == part_of or (sup, OWL.inverseOf, part_of) in rdf
    assert (part_of, RDF.type, OWL.TransitiveProperty) in rdf


def test_owlrl_agrees_on_subproperty_inference():
    try:
        import owlrl
    except ImportError:
        return
    from rdflib import URIRef
    pid = _inherited_pid("part-of")
    _, inverse, _ = rag.core_mapping(pid)
    g = {"nodes": [_n("x", "X"), _n("y", "Y")], "edges": [_e("e1", "x", "y", "특수 구성 관계")]}
    vocab.normalize_graph(g)
    rag._apply_link(g["edges"][0], rag.load_properties()[pid], "llm")
    rdf = graph_to_rdf(g)
    owlrl.DeductiveClosure(owlrl.OWLRL_Semantics).expand(rdf)
    base = "http://autology.local/ontology#"
    x, y, part_of = URIRef(base + "X"), URIRef(base + "Y"), URIRef(base + "part-of")
    expected = (y, part_of, x) if inverse else (x, part_of, y)
    assert expected in rdf


def test_normalize_is_idempotent():
    g = {"nodes": [_n("a", "A"), _n("b", "B", "Class")],
         "edges": [_e("1", "b", "a", "has-instance"), _e("2", "a", "b", "독특한 관계")]}
    once = vocab.normalize_graph(copy.deepcopy(g))
    twice = vocab.normalize_graph(copy.deepcopy(once))
    assert once == twice


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

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


def _fake_chat(answer, verify="a"):
    """Fake LLM: `answer` handles the selection call; the verification call
    (system prompt mentions 'statement') answers `verify` for every item."""
    calls = []

    async def chat(system, user):
        calls.append(user)
        if "statement" in system:
            n = sum(1 for line in user.splitlines() if "property:" in line)
            return json.dumps({"answers": {str(i): verify for i in range(1, n + 1)}})
        return json.dumps(answer(user) if callable(answer) else answer)
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
    chat = _fake_chat({"links": {"연비에 영향": "P999999", "아주 특이한 관계": None}})
    summary = _link(g, chat)
    assert len(chat.calls) == 1                       # one batched call
    assert set(summary["unlinked"]) == {"연비에 영향", "아주 특이한 관계"}
    assert all("wikidata" not in e for e in g["edges"])


def test_llm_choice_links_candidate():
    g = {"nodes": [_n("a", "A"), _n("b", "B")], "edges": [_e("e1", "a", "b", "학교를 졸업함")]}

    def pick_first(user):
        first = user.split("   - ", 1)[1].split(":", 1)[0]
        return {"links": {"학교를 졸업함": first}}
    chat = _fake_chat(pick_first)
    summary = _link(g, chat)
    assert len(chat.calls) == 2                       # select + verify
    assert summary["linked"]["학교를 졸업함"]["method"] == "llm"
    assert g["edges"][0]["wikidata"]["id"] == summary["linked"]["학교를 졸업함"]["id"]


def test_verification_rejects_links():
    g = {"nodes": [_n("phone", "아이폰"), _n("apple", "애플"), _n("a", "A"), _n("b", "B")],
         "edges": [_e("e1", "phone", "apple", "제조사"), _e("e2", "a", "b", "학교를 졸업함")]}

    def pick_first(user):
        block = user.split('Relation "학교를 졸업함"', 1)[1]
        return {"links": {"학교를 졸업함": block.split("   - ", 1)[1].split(":", 1)[0]}}
    summary = _link(g, _fake_chat(pick_first, verify="none"))
    assert summary["linked"] == {}                     # exact matches are verified too
    assert set(summary["rejected"]) == {"제조사", "학교를 졸업함"}
    assert all("wikidata" not in e for e in g["edges"])


def test_verification_switches_to_inverse_property():
    # 애플 —[manufacturer]→ 아이폰 is backwards; the verifier says "b", so the
    # link must switch to P176's inverse (P1056 product or material produced).
    g = {"nodes": [_n("phone", "아이폰"), _n("apple", "애플")],
         "edges": [_e("e1", "apple", "phone", "제조사")]}
    summary = _link(g, _fake_chat({}, verify="b"))
    assert summary["linked"]["제조사"] == {"id": "P1056", "method": "exact+inverse"}
    (edge,) = g["edges"]
    assert (edge["source"], edge["label"], edge["target"]) == ("apple", "produces", "phone")


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

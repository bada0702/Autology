"""추론기와 규칙 기반 검증기 테스트.

실행:
    cd backend && ./venv/Scripts/python tests/test_reasoning.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from reasoning import analyze  # noqa: E402


def _n(nid, label, ntype="Instance"):
    return {"id": nid, "label": label, "type": ntype, "properties": [], "description": ""}


def _e(eid, s, t, label):
    return {"id": eid, "source": s, "target": t, "label": label}


def _triples(result):
    return {(e["source"], e["label"], e["target"]) for e in result["inferred"]}


def _codes(result):
    return [i["code"] for i in result["issues"]]


SAMPLE = {
    "nodes": [
        _n("animal", "동물", "Class"), _n("mammal", "포유류", "Class"), _n("dog", "개", "Class"),
        _n("plant", "식물", "Class"),
        _n("rex", "렉스"),
        _n("heart", "심장"), _n("circ", "순환계"), _n("body", "인체"),
        _n("alice", "앨리스"), _n("team", "연구팀"), _n("lab", "연구소"),
        _n("seoul", "서울"), _n("korea", "한국"),
    ],
    "edges": [
        _e("e1", "dog", "mammal", "is-a"),
        _e("e2", "mammal", "animal", "is-a"),
        _e("e3", "rex", "dog", "is-a"),
        _e("e4", "heart", "circ", "part-of"),
        _e("e5", "body", "circ", "has-part"),     # circ part-of body
        _e("e6", "alice", "team", "member of"),
        _e("e7", "team", "lab", "part-of"),
        _e("e8", "lab", "seoul", "located in"),
        _e("e9", "seoul", "korea", "located in"),
        _e("e10", "animal", "plant", "disjoint with"),
    ],
}


def test_transitivity_and_type_inheritance():
    t = _triples(analyze(SAMPLE))
    assert ("dog", "rdfs:subClassOf", "animal") in t
    assert ("rex", "rdf:type", "mammal") in t
    assert ("rex", "rdf:type", "animal") in t
    assert ("heart", "part-of", "body") in t


def test_property_chains():
    t = _triples(analyze(SAMPLE))
    assert ("alice", "member-of", "lab") in t        # member-of ∘ part-of
    assert ("team", "located-in", "seoul") in t      # part-of ∘ located-in
    assert ("team", "located-in", "korea") in t
    assert ("lab", "located-in", "korea") in t


def test_provenance_points_to_premises():
    r = analyze(SAMPLE)
    ids = {e["id"] for e in SAMPLE["edges"]} | {e["id"] for e in r["inferred"]}
    for e in r["inferred"]:
        assert e["rule"] in ("prp-trp", "prp-spo2", "cax-sco", "cax-eqc")
        assert len(e["premises"]) == 2 and all(p in ids for p in e["premises"]), e
        assert "→" in e["explanation"]
    heart = next(e for e in r["inferred"] if (e["source"], e["target"]) == ("heart", "body"))
    assert heart["premises"] == ["e4", "e5"] and heart["rule"] == "prp-trp"


def test_clean_graph_has_no_errors():
    r = analyze(SAMPLE)
    assert r["stats"]["errors"] == 0, r["issues"]


def test_input_is_not_modified():
    import copy
    before = copy.deepcopy(SAMPLE)
    analyze(SAMPLE)
    assert SAMPLE == before


def test_cycle_detection():
    g = {"nodes": [_n("a", "A"), _n("b", "B"), _n("c", "C")],
         "edges": [_e("1", "a", "b", "part-of"), _e("2", "b", "c", "part-of"), _e("3", "c", "a", "part-of")]}
    r = analyze(g)
    cycles = [i for i in r["issues"] if i["code"] == "cycle"]
    assert len(cycles) == 1 and cycles[0]["severity"] == "error"
    assert set(cycles[0]["node_ids"]) == {"a", "b", "c"}


def test_disjoint_violation_via_inheritance():
    g = {"nodes": SAMPLE["nodes"] + [_n("odd", "이상한 개체")],
         "edges": SAMPLE["edges"] + [_e("x1", "odd", "dog", "is-a"), _e("x2", "odd", "plant", "is-a")]}
    r = analyze(g)
    assert "disjoint_violation" in _codes(r)


def test_unsatisfiable_class():
    g = {"nodes": SAMPLE["nodes"] + [_n("fungus", "균류", "Class")],
         "edges": SAMPLE["edges"] + [_e("x1", "fungus", "animal", "is-a"), _e("x2", "fungus", "plant", "is-a")]}
    assert "unsatisfiable_class" in _codes(analyze(g))


def test_structural_issues():
    g = {"nodes": [_n("a", "A"), _n("b", "B"), _n("lonely", "외톨이"),
                   _n("v1", "42", "Literal"), _n("v2", "kg", "Literal")],
         "edges": [_e("1", "a", "b", "uses"), _e("2", "b", "a", "used by"),  # duplicate after flip
                   _e("3", "a", "a", "uses"), _e("4", "a", "ghost", "uses"),
                   _e("5", "v1", "v2", "has-property"), _e("6", "a", "b", "is-a"),
                   _e("7", "a", "v1", "연관 수치"), _e("8", "b", "v2", "rdf:type")]}
    codes = _codes(analyze(g))
    for code in ("duplicate_edge", "self_loop", "dangling_edge", "orphan_node",
                 "literal_source", "type_target_not_class", "relation_downgraded",
                 "custom_relation"):
        assert code in codes, (code, codes)


def test_matches_owlrl_closure():
    """Our closure must equal owlrl's on the core relations (standard compliance)."""
    try:
        import owlrl
    except ImportError:
        print("  (owlrl not installed — skipped)")
        return
    from rdflib import RDF, RDFS, URIRef
    from semantic import graph_to_rdf, BASE_IRI

    rdf = graph_to_rdf(SAMPLE)
    owlrl.DeductiveClosure(owlrl.OWLRL_Semantics).expand(rdf)

    uri_to_id = {}
    # graph_to_rdf builds URIs from labels; map them back through rdfs:label.
    label_to_id = {n["label"]: n["id"] for n in SAMPLE["nodes"]}
    for s, o in rdf.subject_objects(RDFS.label):
        if str(o) in label_to_id and str(s).startswith(BASE_IRI):
            uri_to_id[s] = label_to_id[str(o)]

    names = {RDF.type: "rdf:type", RDFS.subClassOf: "rdfs:subClassOf"}
    for rel in ("part-of", "member-of", "located-in"):
        names[URIRef(BASE_IRI + rel)] = rel

    owl_triples = {
        (uri_to_id[s], names[p], uri_to_id[o])
        for s, p, o in rdf
        if p in names and s in uri_to_id and o in uri_to_id and s != o
    }
    direct = {(e["source"], e["label"], e["target"]) for e in
              __import__("vocabulary").normalize_graph(__import__("copy").deepcopy(SAMPLE))["edges"]}
    ours = _triples(analyze(SAMPLE)) | direct
    ours = {t for t in ours if t[1] in names.values()}
    assert ours == owl_triples, {"only_ours": ours - owl_triples, "only_owlrl": owl_triples - ours}


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

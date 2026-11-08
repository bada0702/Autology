"""관계 어휘 정규화와 RDF 변환 테스트.

실행:
    cd backend && ./venv/Scripts/python tests/test_vocabulary.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import vocabulary as vocab  # noqa: E402
from semantic import graph_to_rdf, parse_rdf_document, serialize_autology_graph  # noqa: E402


def _node(nid, label, ntype):
    return {"id": nid, "label": label, "type": ntype, "properties": [], "description": ""}


def _edge(eid, s, t, label, **kw):
    return {"id": eid, "source": s, "target": t, "label": label, **kw}


SAMPLE = {
    "nodes": [
        _node("c1", "부품", "Class"),
        _node("c2", "엔진 부품", "Class"),
        _node("i1", "피스톤", "Instance"),
        _node("i2", "엔진", "Instance"),
        _node("i3", "자동차", "Instance"),
    ],
    "edges": [
        _edge("e1", "c2", "c1", "is-a"),        # Class→Class  → subClassOf
        _edge("e2", "i1", "c2", "is-a"),        # Instance→Class → rdf:type
        _edge("e3", "i1", "i2", "일부"),         # → part-of
        _edge("e4", "i3", "i2", "has-part"),    # inverse → flipped part-of
        _edge("e5", "i2", "i3", "연비에 영향"),    # unknown → custom, kept
    ],
}


def test_is_a_resolves_by_node_type():
    assert vocab.resolve("is-a", "Class", "Class").relation == vocab.SUBCLASS
    assert vocab.resolve("is-a", "Instance", "Class").relation == vocab.TYPE
    assert vocab.resolve("subclass of", "Instance", "Class").relation == vocab.TYPE
    assert vocab.resolve("same as", "Instance", "Instance").relation == vocab.SAME_AS
    assert vocab.resolve("동의어", "Class", "Class").relation == vocab.EQUIVALENT_CLASS


def test_aliases_and_inverse_direction():
    assert vocab.resolve("is part of").relation == "part-of"
    assert vocab.resolve("Located_At").relation == "located-in"
    res = vocab.resolve("has-part")
    assert res.relation == "part-of" and res.flipped
    res = vocab.resolve("created by")
    assert res.relation == "produces" and res.flipped


def test_unknown_label_is_kept_as_custom():
    res = vocab.resolve("연비에 영향")
    assert res.relation == vocab.CUSTOM and res.label == "연비에 영향"


def test_normalize_graph():
    import copy
    g = vocab.normalize_graph(copy.deepcopy(SAMPLE))
    by_id = {e["id"]: e for e in g["edges"]}
    assert by_id["e1"]["label"] == vocab.SUBCLASS
    assert by_id["e2"]["label"] == vocab.TYPE
    assert by_id["e2"]["original_label"] == "is-a"
    assert by_id["e3"]["label"] == "part-of"
    assert (by_id["e4"]["source"], by_id["e4"]["target"]) == ("i2", "i3")
    assert by_id["e5"]["relation"] == vocab.CUSTOM


def test_normalize_drops_duplicates_from_inverse_phrasing():
    g = {
        "nodes": [_node("a", "엔진", "Class"), _node("b", "자동차", "Class")],
        "edges": [_edge("e1", "a", "b", "part-of"), _edge("e2", "b", "a", "has part")],
    }
    assert len(vocab.normalize_graph(g)["edges"]) == 1


def test_rdf_uses_builtins_and_axioms():
    ttl = serialize_autology_graph(SAMPLE)
    assert "rdfs:subClassOf" in ttl
    assert "owl:TransitiveProperty" in ttl
    assert "owl:propertyChainAxiom" not in ttl  # member-of/located-in unused
    assert ':is-a' not in ttl


def test_rdf_declares_chain_dependencies():
    g = {
        "nodes": [_node("a", "Alice", "Instance"), _node("b", "Team", "Instance")],
        "edges": [_edge("e1", "a", "b", "member of")],
    }
    from rdflib import OWL, RDF, URIRef
    rdf = graph_to_rdf(g)
    part_of = URIRef("http://autology.local/ontology#part-of")
    assert any(True for _ in rdf.subject_objects(OWL.propertyChainAxiom))
    assert (part_of, RDF.type, OWL.TransitiveProperty) in rdf


def test_duplicate_labels_get_distinct_uris():
    g = {
        "nodes": [_node("a", "Mercury", "Instance"), _node("b", "Mercury", "Instance")],
        "edges": [],
    }
    rdf = graph_to_rdf(g)
    from rdflib import OWL, RDF
    assert len(set(rdf.subjects(RDF.type, OWL.NamedIndividual))) == 2


def test_transitive_path_query():
    rdf = graph_to_rdf(SAMPLE)
    q = """
    PREFIX : <http://autology.local/ontology#>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?name WHERE {
        ?a rdfs:label "피스톤"@ko .
        ?a :part-of+ ?y .
        ?y rdfs:label ?name .
    }
    """
    found = {str(r[0]) for r in rdf.query(q)}
    assert found == {"엔진", "자동차"}, found


def test_roundtrip_has_no_property_nodes():
    ttl = serialize_autology_graph(SAMPLE)
    back = parse_rdf_document(ttl)
    labels = {n["label"] for n in back["nodes"]}
    assert labels == {"부품", "엔진 부품", "피스톤", "엔진", "자동차"}, labels
    edge_labels = {e["label"] for e in back["edges"]}
    assert {"rdfs:subClassOf", "rdf:type", "part-of"} <= edge_labels, edge_labels


def test_language_tag_detection():
    g = {"nodes": [_node("a", "Person", "Class"), _node("b", "사람", "Class")], "edges": []}
    ttl = serialize_autology_graph(g)
    assert '"Person"@en' in ttl and '"사람"@ko' in ttl


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

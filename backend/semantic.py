"""
Standard semantic-web helpers for Autology.

The frontend keeps a compact graph model. This module converts that model to
RDFLib graphs when rdflib is installed, then exposes standard parsing,
serialization, SPARQL, and SHACL validation primitives for expert workflows.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import re
from urllib.parse import quote

import vocabulary as vocab


BASE_IRI = "http://autology.local/ontology#"
BASE_NS = "http://autology.local/ontology"
WIKIDATA_ENTITY = "http://www.wikidata.org/entity/"


@dataclass
class SemanticUnavailable(RuntimeError):
    package: str

    def __str__(self) -> str:
        return f"{self.package} is not installed. Install backend requirements first."


def _require_rdflib():
    try:
        import rdflib
        from rdflib import Graph, Literal, Namespace, RDF, RDFS, OWL, URIRef
    except Exception as exc:
        raise SemanticUnavailable("rdflib") from exc
    return rdflib, Graph, Literal, Namespace, RDF, RDFS, OWL, URIRef


def _local_name(value: str, fallback: str) -> str:
    raw = str(value or fallback).strip() or fallback
    return quote(raw.replace(" ", "_"), safe="-_.~")


_HANGUL = re.compile(r"[가-힣]")


def _lang_of(text: str) -> str:
    return "ko" if _HANGUL.search(text or "") else "en"


def _text(value: str, literal_cls) -> Any:
    return literal_cls(value, lang=_lang_of(value))


def graph_to_rdf(graph: dict[str, Any], include_inferred: bool = False):
    """Convert Autology graph JSON to an RDFLib graph.

    Edge labels are resolved against the core vocabulary (vocabulary.py), so
    LLM phrasings like "is-a" become rdfs:subClassOf / rdf:type and core
    relations carry their OWL characteristics (transitive, inverse, chains).
    Node URIs come from labels for readability, made unique per graph.
    Inferred edges are skipped by default: a reasoner should re-derive them.
    """
    from rdflib.collection import Collection
    from rdflib.namespace import SKOS
    from rdflib import BNode

    _, Graph, Literal, Namespace, RDF, RDFS, OWL, URIRef = _require_rdflib()

    g = Graph()
    aut = Namespace(BASE_IRI)
    g.bind("", aut)
    g.bind("owl", OWL)
    g.bind("rdf", RDF)
    g.bind("rdfs", RDFS)
    g.bind("skos", SKOS)

    g.add((URIRef(BASE_NS), RDF.type, OWL.Ontology))

    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    uri_by_id: dict[str, Any] = {}
    type_by_id: dict[str, str] = {}
    used_locals: set[str] = set()
    used_relations: set[str] = set()

    for i, node in enumerate(nodes):
        base = _local_name(node.get("label") or node.get("id"), f"n{i + 1}")
        local, n = base, 2
        while local in used_locals:
            local, n = f"{base}_{n}", n + 1
        used_locals.add(local)
        uri = URIRef(BASE_IRI + local)
        uri_by_id[node.get("id")] = uri
        node_type = node.get("type") or "Class"
        type_by_id[node.get("id")] = node_type
        if node_type == "Literal":
            g.add((uri, RDF.type, RDFS.Datatype))
        elif node_type == "Instance":
            g.add((uri, RDF.type, OWL.NamedIndividual))
        else:
            g.add((uri, RDF.type, OWL.Class))

        if node.get("label"):
            g.add((uri, RDFS.label, _text(node["label"], Literal)))
        if node.get("description"):
            g.add((uri, RDFS.comment, _text(node["description"], Literal)))
        if node.get("wikidata_id"):
            # skos:exactMatch rather than owl:sameAs: it links without importing
            # Wikidata's semantics into the reasoner (and works for classes).
            g.add((uri, SKOS.exactMatch, URIRef(WIKIDATA_ENTITY + node["wikidata_id"])))
        for prop in node.get("properties") or []:
            key = prop.get("key")
            if not key:
                continue
            pred = URIRef(BASE_IRI + _local_name(key, "property"))
            g.add((uri, pred, Literal(str(prop.get("value", "")))))

    builtin = {
        vocab.TYPE: RDF.type,
        vocab.SUBCLASS: RDFS.subClassOf,
        vocab.EQUIVALENT_CLASS: OWL.equivalentClass,
        vocab.SAME_AS: OWL.sameAs,
        vocab.DISJOINT: OWL.disjointWith,
    }

    def relation_uri(rel_id: str):
        return URIRef(BASE_IRI + _local_name(rel_id, "related-to"))

    for edge in edges:
        if edge.get("inferred") and not include_inferred:
            continue
        s_id, t_id = edge.get("source"), edge.get("target")
        res = vocab.resolve(edge.get("label") or "", type_by_id.get(s_id), type_by_id.get(t_id))
        if res.flipped:
            s_id, t_id = t_id, s_id
        src, tgt = uri_by_id.get(s_id), uri_by_id.get(t_id)
        if not src or not tgt:
            continue

        if res.relation in builtin:
            pred = builtin[res.relation]
        elif res.relation == vocab.CUSTOM:
            pred = relation_uri(res.label)
            g.add((pred, RDF.type, OWL.ObjectProperty))
            g.add((pred, RDFS.label, _text(res.label, Literal)))
            # Vocabulary links made by vocab_rag.py
            wd = edge.get("wikidata") or {}
            if wd.get("id"):
                g.add((pred, SKOS.exactMatch, URIRef(WIKIDATA_ENTITY + wd["id"])))
                if wd.get("transitive"):
                    g.add((pred, RDF.type, OWL.TransitiveProperty))
            sup = edge.get("super_relation")
            if sup in vocab.BY_ID and sup not in builtin:
                if edge.get("super_inverse"):
                    inv = relation_uri(f"inv-{sup}")
                    g.add((inv, RDF.type, OWL.ObjectProperty))
                    g.add((inv, OWL.inverseOf, relation_uri(sup)))
                    g.add((pred, RDFS.subPropertyOf, inv))
                else:
                    g.add((pred, RDFS.subPropertyOf, relation_uri(sup)))
                used_relations.add(sup)
        else:
            pred = relation_uri(res.relation)
            used_relations.add(res.relation)
        g.add((src, pred, tgt))

    # Declare the axioms of every core relation that was used (plus the
    # relations their property chains depend on).
    pending = list(used_relations)
    declared: set[str] = set()
    while pending:
        rel_id = pending.pop()
        if rel_id in declared or rel_id not in vocab.BY_ID:
            continue
        declared.add(rel_id)
        rel = vocab.BY_ID[rel_id]
        pred = relation_uri(rel_id)
        g.add((pred, RDF.type, OWL.ObjectProperty))
        g.add((pred, RDFS.label, Literal(rel.ko, lang="ko")))
        g.add((pred, RDFS.label, Literal(rel.en, lang="en")))
        g.add((pred, RDFS.comment, Literal(rel.description, lang="en")))
        if rel.transitive:
            g.add((pred, RDF.type, OWL.TransitiveProperty))
        if rel.symmetric:
            g.add((pred, RDF.type, OWL.SymmetricProperty))
        for iri in rel.match:
            g.add((pred, SKOS.exactMatch, URIRef(iri)))
        for p1, p2 in rel.chains:
            chain = BNode()
            Collection(g, chain, [relation_uri(p1), relation_uri(p2)])
            g.add((pred, OWL.propertyChainAxiom, chain))
            pending.extend([p1, p2])

    return g


def serialize_autology_graph(graph: dict[str, Any], rdf_format: str = "turtle") -> str:
    g = graph_to_rdf(graph)
    return g.serialize(format=rdf_format)


def parse_rdf_document(content: str, rdf_format: str = "turtle") -> dict[str, Any]:
    _, Graph, Literal, Namespace, RDF, RDFS, OWL, URIRef = _require_rdflib()
    g = Graph()
    g.parse(data=content, format=rdf_format)

    node_types = {}
    labels = {}
    descriptions = {}
    edges = []
    resources = set()

    def remember(term):
      if isinstance(term, URIRef) and not str(term).startswith("http://www.w3.org/"):
          resources.add(term)

    # Property and ontology declarations describe the schema, not the domain:
    # they must not show up as canvas nodes.
    schema_types = {
        OWL.Ontology, RDF.Property, OWL.ObjectProperty, OWL.DatatypeProperty,
        OWL.AnnotationProperty, OWL.TransitiveProperty, OWL.SymmetricProperty,
    }
    schema_terms = {s for s, o in g.subject_objects(RDF.type) if o in schema_types}
    schema_terms |= set(g.predicates())

    for s, p, o in g:
        if s in schema_terms:
            continue
        remember(s)
        remember(o)
        if p == RDFS.label and isinstance(o, Literal):
            labels[s] = str(o)
        elif p == RDFS.comment and isinstance(o, Literal):
            descriptions[s] = str(o)
        elif p == RDF.type:
            if o == OWL.Class:
                node_types[s] = "Class"
            elif o == OWL.NamedIndividual:
                node_types[s] = "Instance"
            elif o == RDFS.Datatype:
                node_types[s] = "Literal"
            elif isinstance(o, URIRef) and not str(o).startswith("http://www.w3.org/"):
                edges.append((s, "rdf:type", o))
        elif p == RDFS.subClassOf:
            edges.append((s, "rdfs:subClassOf", o))
        elif p == OWL.equivalentClass:
            edges.append((s, "owl:equivalentClass", o))
        elif p == OWL.disjointWith:
            edges.append((s, "owl:disjointWith", o))
        elif p == OWL.sameAs:
            edges.append((s, "owl:sameAs", o))
        elif isinstance(o, URIRef) and not str(p).startswith("http://www.w3.org/"):
            edges.append((s, _display_name(p), o))

    ordered = list(resources)
    id_by_uri = {uri: f"node_{i + 1}" for i, uri in enumerate(ordered)}
    nodes = []
    for i, uri in enumerate(ordered):
        nodes.append({
            "id": id_by_uri[uri],
            "label": labels.get(uri) or _display_name(uri),
            "type": node_types.get(uri, "Instance"),
            "x": (i % 5) * 220 + 80,
            "y": 120 + (i // 5) * 150,
            "properties": [],
            "description": descriptions.get(uri, ""),
        })

    out_edges = []
    seen = set()
    for i, (s, label, o) in enumerate(edges):
        if s not in id_by_uri or o not in id_by_uri:
            continue
        key = (id_by_uri[s], label, id_by_uri[o])
        if key in seen:
            continue
        seen.add(key)
        out_edges.append({
            "id": f"edge_{i + 1}",
            "source": id_by_uri[s],
            "target": id_by_uri[o],
            "label": label,
            "style": "solid",
            "inferred": False,
        })

    return {"nodes": nodes, "edges": out_edges}


def run_sparql(content: str, query: str, rdf_format: str = "turtle") -> dict[str, Any]:
    _, Graph, *_ = _require_rdflib()
    g = Graph()
    g.parse(data=content, format=rdf_format)
    result = g.query(query)
    vars_ = [str(v) for v in getattr(result, "vars", [])]
    rows = []
    for row in result:
        rows.append({vars_[i]: str(row[i]) if row[i] is not None else None for i in range(len(vars_))})
    return {"variables": vars_, "rows": rows}


def validate_shacl(data: str, shapes: str, data_format: str = "turtle", shapes_format: str = "turtle") -> dict[str, Any]:
    _require_rdflib()
    try:
        from pyshacl import validate
    except Exception as exc:
        raise SemanticUnavailable("pyshacl") from exc

    conforms, report_graph, report_text = validate(
        data_graph=data,
        shacl_graph=shapes,
        data_graph_format=data_format,
        shacl_graph_format=shapes_format,
        inference="rdfs",
        serialize_report_graph="turtle",
    )
    return {
        "conforms": bool(conforms),
        "report_text": str(report_text),
        "report_turtle": report_graph.decode("utf-8") if isinstance(report_graph, bytes) else str(report_graph),
    }


def _display_name(uri: Any) -> str:
    text = str(uri)
    if "#" in text:
        return text.rsplit("#", 1)[1]
    return text.rstrip("/").rsplit("/", 1)[-1]

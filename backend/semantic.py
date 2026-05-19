"""
Standard semantic-web helpers for Autology.

The frontend keeps a compact graph model. This module converts that model to
RDFLib graphs when rdflib is installed, then exposes standard parsing,
serialization, SPARQL, and SHACL validation primitives for expert workflows.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote


BASE_IRI = "http://autology.local/ontology#"
BASE_NS = "http://autology.local/ontology"


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


def _node_uri(node: dict[str, Any], index: int, uri_ref) -> Any:
    local = _local_name(node.get("label") or node.get("id"), f"n{index + 1}")
    return uri_ref(BASE_IRI + local)


def graph_to_rdf(graph: dict[str, Any]):
    _, Graph, Literal, Namespace, RDF, RDFS, OWL, URIRef = _require_rdflib()

    g = Graph()
    aut = Namespace(BASE_IRI)
    g.bind("", aut)
    g.bind("owl", OWL)
    g.bind("rdf", RDF)
    g.bind("rdfs", RDFS)

    g.add((URIRef(BASE_NS), RDF.type, OWL.Ontology))

    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    uri_by_id: dict[str, Any] = {}

    for i, node in enumerate(nodes):
        uri = _node_uri(node, i, URIRef)
        uri_by_id[node.get("id")] = uri
        node_type = node.get("type") or "Class"
        if node_type == "Class":
            g.add((uri, RDF.type, OWL.Class))
        elif node_type == "Literal":
            g.add((uri, RDF.type, RDFS.Datatype))
        else:
            g.add((uri, RDF.type, OWL.NamedIndividual))

        if node.get("label"):
            g.add((uri, RDFS.label, Literal(node["label"], lang="ko")))
        if node.get("description"):
            g.add((uri, RDFS.comment, Literal(node["description"], lang="ko")))
        for prop in node.get("properties") or []:
            key = prop.get("key")
            if not key:
                continue
            pred = URIRef(BASE_IRI + _local_name(key, "property"))
            g.add((uri, pred, Literal(str(prop.get("value", "")))))

    for edge in edges:
        src = uri_by_id.get(edge.get("source"))
        tgt = uri_by_id.get(edge.get("target"))
        if not src or not tgt:
            continue

        label = edge.get("label") or "relatedTo"
        if label == "rdf:type":
            pred = RDF.type
        elif label == "rdfs:subClassOf":
            pred = RDFS.subClassOf
        elif label == "owl:equivalentClass":
            pred = OWL.equivalentClass
        elif label == "owl:disjointWith":
            pred = OWL.disjointWith
        else:
            pred = URIRef(BASE_IRI + _local_name(label, "relatedTo"))
            g.add((pred, RDF.type, OWL.ObjectProperty))
            g.add((pred, RDFS.label, Literal(label, lang="ko")))
        g.add((src, pred, tgt))

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

    for s, p, o in g:
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

"""
Core relation vocabulary for Autology.

LLM agents produce free-text edge labels ("is-a", "소속", "belongs to", ...).
A reasoner cannot do anything with free text, so this module pins a small,
domain-agnostic set of relations whose logical characteristics are declared
(transitive, symmetric, inverse, property chains). Every generated edge is
normalized onto this set; labels that do not match are kept verbatim as
custom relations (candidates for later vocabulary extension).

Canonical relation ids double as edge labels in the graph JSON. The RDFS/OWL
built-ins keep their prefixed names ("rdf:type", "rdfs:subClassOf") because
the frontend rule engine and the RDF importer already use those spellings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

SUBCLASS = "rdfs:subClassOf"
TYPE = "rdf:type"
EQUIVALENT_CLASS = "owl:equivalentClass"
SAME_AS = "owl:sameAs"
DISJOINT = "owl:disjointWith"
RELATED = "related-to"
CUSTOM = "custom"


@dataclass(frozen=True)
class Relation:
    id: str
    ko: str
    en: str
    description: str
    builtin: bool = False             # maps to an RDFS/OWL built-in predicate
    transitive: bool = False
    symmetric: bool = False
    inverse_ko: str = ""              # display name of the inverse direction
    chains: tuple[tuple[str, str], ...] = ()   # (p1, p2): p1 ∘ p2 ⊑ self
    match: tuple[str, ...] = ()       # external IRIs (skos:exactMatch)
    aliases: tuple[str, ...] = ()
    inverse_aliases: tuple[str, ...] = ()       # labels meaning the reverse direction


RO = "http://purl.obolibrary.org/obo/"

CORE_RELATIONS: tuple[Relation, ...] = (
    Relation(
        SUBCLASS, "하위 클래스", "subclass of",
        "Class → Class. A is a kind of B.",
        builtin=True, transitive=True,
        aliases=("is-a", "isa", "is-a-kind-of", "kind-of", "subclass-of", "subclass",
                 "subclassof", "type-of", "a-kind-of", "하위클래스", "하위-클래스",
                 "하위개념", "하위-개념", "종류", "의-종류", "~의-종류", "일종"),
        inverse_aliases=("has-subclass", "superclass-of", "상위클래스", "상위-클래스",
                         "상위개념", "상위-개념"),
    ),
    Relation(
        TYPE, "인스턴스", "instance of",
        "Instance → Class. A is a concrete member of class B.",
        builtin=True,
        aliases=("instance-of", "instanceof", "is-instance-of", "example-of", "type",
                 "rdf-type", "인스턴스", "의-인스턴스", "사례", "예시", "실체"),
        inverse_aliases=("has-instance", "has-example", "인스턴스-보유", "예시-보유"),
    ),
    Relation(
        "part-of", "부분", "part of",
        "A is a component/part of B. Transitive.",
        transitive=True, inverse_ko="구성 요소 보유",
        match=(RO + "BFO_0000050",),
        aliases=("partof", "is-part-of", "component-of", "belongs-to", "부분", "일부",
                 "의-일부", "부분-관계", "구성요소", "구성-요소", "소속", "속함", "포함됨", "부품"),
        inverse_aliases=("has-part", "haspart", "has-component", "contains", "consists-of",
                         "composed-of", "includes", "구성", "포함", "포함한다", "가짐-부분"),
    ),
    Relation(
        "member-of", "구성원", "member of",
        "A (individual/agent) is a member of group/organization B. "
        "Chains: member-of ∘ part-of ⊑ member-of.",
        chains=(("member-of", "part-of"),), inverse_ko="구성원 보유",
        match=(RO + "RO_0002350",),
        aliases=("memberof", "is-member-of", "구성원", "멤버", "회원", "소속-구성원"),
        inverse_aliases=("has-member", "구성원-보유", "멤버-보유"),
    ),
    Relation(
        "located-in", "위치", "located in",
        "A is spatially located in B. Transitive. Chains: part-of ∘ located-in ⊑ located-in.",
        transitive=True, chains=(("part-of", "located-in"),), inverse_ko="위치 포함",
        match=(RO + "RO_0001025",),
        aliases=("located-at", "locatedin", "location", "is-located-in", "situated-in",
                 "위치", "위치함", "에-위치", "소재", "소재지", "에-있다", "에-있음", "에-존재"),
        inverse_aliases=("location-of", "contains-location", "위치-포함"),
    ),
    Relation(
        "has-property", "속성", "has property",
        "A has attribute/value B (B is usually a Literal).",
        aliases=("has-value", "hasvalue", "has-attribute", "attribute", "property", "value",
                 "속성", "값", "특성", "속성값"),
        inverse_aliases=("property-of", "value-of", "attribute-of"),
    ),
    Relation(
        "causes", "원인", "causes",
        "A causes or brings about B.",
        inverse_ko="결과",
        match=(RO + "RO_0002410",),
        aliases=("cause", "leads-to", "results-in", "triggers", "원인", "유발", "초래",
                 "야기", "일으킴"),
        inverse_aliases=("caused-by", "result-of", "effect-of", "결과", "기인"),
    ),
    Relation(
        "precedes", "선행", "precedes",
        "A happens before B. Transitive.",
        transitive=True, inverse_ko="후행",
        match=(RO + "BFO_0000063",),
        aliases=("before", "prior-to", "followed-by", "comes-before", "선행", "앞섬", "이전"),
        inverse_aliases=("follows", "after", "succeeds", "comes-after", "후행", "뒤따름", "이후",
                         "이후에-발생", "다음에-발생"),
    ),
    Relation(
        "depends-on", "의존", "depends on",
        "A requires or depends on B.",
        inverse_ko="의존 대상",
        aliases=("dependson", "requires", "needs", "relies-on", "의존", "필요", "요구"),
        inverse_aliases=("required-by", "needed-by", "dependency-of"),
    ),
    Relation(
        "participates-in", "참여", "participates in",
        "A takes part in process/event B.",
        inverse_ko="참여자",
        match=(RO + "RO_0000056",),
        aliases=("participatesin", "takes-part-in", "involved-in", "참여", "참가", "관여"),
        inverse_aliases=("has-participant", "involves", "참여자"),
    ),
    Relation(
        "produces", "생산", "produces",
        "A creates, produces, or develops B.",
        inverse_ko="생산자",
        aliases=("creates", "develops", "makes", "generates", "manufactures", "authored",
                 "생산", "제작", "개발", "창작", "생성", "제조", "만든다", "만듦", "만들다"),
        inverse_aliases=("produced-by", "created-by", "developed-by", "made-by",
                         "authored-by", "생산자", "제작자", "개발자"),
    ),
    Relation(
        "uses", "사용", "uses",
        "A uses B as an instrument or resource.",
        inverse_ko="사용됨",
        aliases=("utilizes", "employs", "사용", "활용", "이용"),
        inverse_aliases=("used-by", "사용됨"),
    ),
    Relation(
        EQUIVALENT_CLASS, "동치", "equivalent to",
        "Same meaning. Class↔Class becomes owl:equivalentClass, Instance↔Instance owl:sameAs.",
        builtin=True, symmetric=True,
        aliases=("equivalent-to", "equivalent", "same-as", "sameas", "synonym", "alias",
                 "owl:sameas", "동일", "동치", "같음", "동의어", "별칭"),
    ),
    Relation(
        DISJOINT, "배타", "disjoint with",
        "Class ↔ Class. Nothing can be an instance of both.",
        builtin=True, symmetric=True,
        aliases=("disjoint-with", "disjoint", "mutually-exclusive", "배타", "서로소",
                 "상호배타"),
    ),
    Relation(
        RELATED, "관련", "related to",
        "Generic association. Use ONLY when no other relation fits.",
        symmetric=True,
        aliases=("related", "relatedto", "associated-with", "association", "관련", "연관",
                 "관계"),
    ),
)

BY_ID: dict[str, Relation] = {r.id: r for r in CORE_RELATIONS}
SYMMETRIC = {r.id for r in CORE_RELATIONS if r.symmetric} | {SAME_AS}


def _key(label: str) -> str:
    text = str(label or "").strip().lower()
    text = re.sub(r"[\s_]+", "-", text)
    return text.strip("-")


_FORWARD: dict[str, str] = {}
_INVERSE: dict[str, str] = {}
for _rel in CORE_RELATIONS:
    _FORWARD[_key(_rel.id)] = _rel.id
    for _a in _rel.aliases:
        _FORWARD[_key(_a)] = _rel.id
    for _a in _rel.inverse_aliases:
        _INVERSE[_key(_a)] = _rel.id
# Spacing varies in Korean ("구성 요소" / "구성요소"): also index without hyphens.
for _table in (_FORWARD, _INVERSE):
    for _k, _v in list(_table.items()):
        _table.setdefault(_k.replace("-", ""), _v)


@dataclass
class Resolution:
    relation: str               # canonical id, or CUSTOM
    label: str                  # label to store on the edge
    flipped: bool = False       # source/target must be swapped
    notes: list[str] = field(default_factory=list)


_HANGUL = re.compile(r"[가-힣]")
# Predicate endings LLMs attach to Korean relation nouns ("사용한다", "원인이다",
# "위치함"). Longest first. "한다/된다/하다/되다" also map to the "-함/-됨" noun
# forms used in the alias lists ("속한다" → "속함").
_KO_ENDINGS = ("입니다", "합니다", "됩니다", "이에요", "이다", "한다", "된다", "하다", "되다",
               "있다", "있음", "함", "됨", "임")
_KO_NOMINAL = {"한다": "함", "하다": "함", "합니다": "함", "된다": "됨", "되다": "됨", "됩니다": "됨"}
# Particles left on the stem ("관련이 있다", "필요로 한다") or in front ("의 결과").
_KO_TAIL = ("으로", "에서", "이", "가", "을", "를", "로", "에", "와", "과")
_KO_HEAD = ("의-", "에-")


def _korean_variants(key: str) -> list[str]:
    """Base forms of a Korean predicate phrase, most specific first."""
    stems = []
    for end in _KO_ENDINGS:
        if key.endswith(end) and len(key) > len(end):
            stem = key[: -len(end)].rstrip("-")
            stems.append(stem)
            if end in _KO_NOMINAL:
                stems.append(stem + _KO_NOMINAL[end])
            break
    out = []
    for stem in [key, *stems]:
        forms = [stem]
        for tail in _KO_TAIL:
            if stem.endswith(tail) and len(stem) - len(tail) >= 2:
                forms.append(stem[: -len(tail)].rstrip("-"))
                break
        for form in list(forms):
            for head in _KO_HEAD:
                if form.startswith(head) and len(form) - len(head) >= 2:
                    forms.append(form[len(head):])
        out.extend(f for f in forms if len(f) >= 2)
    return out


def _lookup(label: str) -> tuple[str | None, bool]:
    key = _key(label)
    candidates = [key]
    for prefix in ("is-", "are-", "was-"):
        if key.startswith(prefix):
            candidates.append(key[len(prefix):])
    if _HANGUL.search(key):
        candidates += _korean_variants(key)
    for cand in dict.fromkeys(candidates):
        for c in (cand, cand.replace("-", "")):
            if c in _FORWARD:
                return _FORWARD[c], False
            if c in _INVERSE:
                return _INVERSE[c], True
    return None, False


def resolve(label: str, source_type: str | None = None, target_type: str | None = None) -> Resolution:
    """Map a free-text edge label onto the core vocabulary.

    source_type / target_type are node types (Class / Instance / Literal /
    custom). They disambiguate "is-a" and equivalence, which mean different
    RDF predicates depending on what they connect.
    """
    original = str(label or "").strip()
    rel_id, flipped = _lookup(original)
    if rel_id is None:
        if not original:
            return Resolution(RELATED, RELATED, notes=["empty label → related-to"])
        return Resolution(CUSTOM, original)

    src, tgt = (target_type, source_type) if flipped else (source_type, target_type)
    notes: list[str] = []

    if rel_id in (SUBCLASS, TYPE):
        # The LLM uses is-a for both class hierarchy and instantiation.
        if _is_class(tgt):
            rel_id = SUBCLASS if _is_class(src) else TYPE
        elif tgt == "Instance" and src == "Instance":
            notes.append("is-a between two instances → related-to")
            rel_id = RELATED
    elif rel_id == EQUIVALENT_CLASS:
        if src == "Instance" and tgt == "Instance":
            rel_id = SAME_AS

    return Resolution(rel_id, rel_id, flipped=flipped, notes=notes)


def _is_class(node_type: str | None) -> bool:
    # Extraction may emit domain-specific types via schema evolution; anything
    # that is not explicitly an Instance or Literal is treated as class-like.
    return node_type is not None and node_type not in ("Instance", "Literal")


def normalize_graph(graph: dict[str, Any]) -> dict[str, Any]:
    """Normalize every non-inferred edge label in-place and return the graph.

    Adds `relation` (canonical id or "custom") and `original_label` to each
    edge, swaps direction for inverse phrasings, and drops duplicates and
    self-loops created by normalization.
    """
    nodes = graph.get("nodes") or []
    type_by_id = {n.get("id"): n.get("type") or "Class" for n in nodes}
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()

    for edge in graph.get("edges") or []:
        if edge.get("inferred"):
            out.append(edge)
            continue
        src, tgt = edge.get("source"), edge.get("target")
        # Resolve the current label: canonical labels resolve to themselves,
        # so re-normalizing is idempotent and keeps rewrites made after the
        # first pass (e.g. Wikidata linking).
        current = edge.get("label") or ""
        original = edge.get("original_label") or current
        res = resolve(current, type_by_id.get(src), type_by_id.get(tgt))
        if res.flipped:
            src, tgt = tgt, src
        if not src or not tgt or src == tgt:
            continue
        key = (src, tgt, res.label)
        if key in seen:
            continue
        if res.relation in SYMMETRIC and (tgt, src, res.label) in seen:
            continue
        seen.add(key)
        new_edge = dict(edge)
        new_edge.update(source=src, target=tgt, label=res.label, relation=res.relation)
        if _key(original) != _key(res.label):
            new_edge["original_label"] = original
        if res.notes:
            new_edge["normalization_note"] = "; ".join(res.notes)
        out.append(new_edge)

    graph["edges"] = out
    return graph


def prompt_block(language: str = "Korean") -> str:
    """Relation list for LLM prompts."""
    lines = []
    for r in CORE_RELATIONS:
        if r.id == SAME_AS:
            continue
        extra = []
        if r.transitive:
            extra.append("transitive")
        if r.symmetric:
            extra.append("symmetric")
        tag = f" [{', '.join(extra)}]" if extra else ""
        lines.append(f'- "{r.id}" ({r.ko}){tag}: {r.description}')
    return (
        "Edge \"label\" MUST be one of these relation ids, copied exactly:\n"
        + "\n".join(lines)
        + "\nRules: Class→Class hierarchy uses \"rdfs:subClassOf\"; Instance→Class uses \"rdf:type\". "
        "Always write the relation in the listed direction (use part-of, never has-part). "
        "Only if none of the ids fits, write a short custom label (2-4 words) in "
        f"{language}; do not use related-to when a specific custom label is clearer."
    )

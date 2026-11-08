"""
Build backend/resources/wikidata_properties.json from the Wikidata Query Service.

Collects every item-valued Wikidata property (relations between entities) with
Korean/English labels, descriptions and aliases, plus the structural facts the
reasoner can use: superproperties (P1647), inverse properties (P1696) and
whether Wikidata marks the property transitive or symmetric.

Wikidata content is CC0, so the output can be bundled with the app.

Usage:
    cd backend && ./venv/Scripts/python scripts/build_wikidata_vocab.py
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import date

import httpx

ENDPOINT = "https://query.wikidata.org/sparql"
USER_AGENT = "Autology/1.0 (ontology builder; https://github.com/)"
OUT = os.path.join(os.path.dirname(__file__), "..", "resources", "wikidata_properties.json")

TRANSITIVE = "Q18647515"
SYMMETRIC = "Q18647518"

# One query per facet keeps each response small and avoids WDQS timeouts.
QUERIES = {
    "labels": """
SELECT ?p ?label_ko ?label_en ?desc_ko ?desc_en WHERE {
  ?p wikibase:propertyType wikibase:WikibaseItem .
  OPTIONAL { ?p rdfs:label ?label_ko FILTER(LANG(?label_ko) = "ko") }
  OPTIONAL { ?p rdfs:label ?label_en FILTER(LANG(?label_en) = "en") }
  OPTIONAL { ?p schema:description ?desc_ko FILTER(LANG(?desc_ko) = "ko") }
  OPTIONAL { ?p schema:description ?desc_en FILTER(LANG(?desc_en) = "en") }
}""",
    "aliases": """
SELECT ?p ?alias WHERE {
  ?p wikibase:propertyType wikibase:WikibaseItem ;
     skos:altLabel ?alias .
  FILTER(LANG(?alias) IN ("ko", "en"))
}""",
    "structure": """
SELECT ?p ?super ?inverse ?kind WHERE {
  ?p wikibase:propertyType wikibase:WikibaseItem .
  OPTIONAL { ?p wdt:P1647 ?super }
  OPTIONAL { ?p wdt:P1696 ?inverse }
  OPTIONAL { ?p wdt:P31 ?kind FILTER(?kind IN (wd:%s, wd:%s)) }
}""" % (TRANSITIVE, SYMMETRIC),
}


def _pid(uri: str) -> str:
    return uri.rsplit("/", 1)[-1]


def _query(sparql: str) -> list[dict]:
    for attempt in range(3):
        try:
            r = httpx.get(
                ENDPOINT,
                params={"query": sparql, "format": "json"},
                headers={"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"},
                timeout=120,
            )
            r.raise_for_status()
            return r.json()["results"]["bindings"]
        except Exception as exc:  # noqa: BLE001
            print(f"  retry {attempt + 1}: {exc}", file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("Wikidata query failed")


def build() -> dict:
    props: dict[str, dict] = {}

    def entry(pid: str) -> dict:
        return props.setdefault(pid, {
            "id": pid, "label": {}, "description": {}, "aliases": {"ko": [], "en": []},
            "super": [], "inverse": [], "transitive": False, "symmetric": False,
        })

    print("labels…")
    for row in _query(QUERIES["labels"]):
        e = entry(_pid(row["p"]["value"]))
        for lang in ("ko", "en"):
            if f"label_{lang}" in row:
                e["label"][lang] = row[f"label_{lang}"]["value"]
            if f"desc_{lang}" in row:
                e["description"][lang] = row[f"desc_{lang}"]["value"]

    print("aliases…")
    for row in _query(QUERIES["aliases"]):
        e = entry(_pid(row["p"]["value"]))
        alias = row["alias"]
        lang = alias.get("xml:lang", "en")
        if alias["value"] not in e["aliases"][lang]:
            e["aliases"][lang].append(alias["value"])

    print("structure…")
    for row in _query(QUERIES["structure"]):
        e = entry(_pid(row["p"]["value"]))
        if "super" in row and _pid(row["super"]["value"]) not in e["super"]:
            e["super"].append(_pid(row["super"]["value"]))
        if "inverse" in row and _pid(row["inverse"]["value"]) not in e["inverse"]:
            e["inverse"].append(_pid(row["inverse"]["value"]))
        if "kind" in row:
            kind = _pid(row["kind"]["value"])
            e["transitive"] |= kind == TRANSITIVE
            e["symmetric"] |= kind == SYMMETRIC

    # Properties without any label cannot be retrieved or shown.
    items = sorted((p for p in props.values() if p["label"]), key=lambda p: int(p["id"][1:]))
    return {
        "source": "Wikidata Query Service (CC0)",
        "retrieved": date.today().isoformat(),
        "count": len(items),
        "properties": items,
    }


if __name__ == "__main__":
    data = build()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    ko = sum(1 for p in data["properties"] if "ko" in p["label"])
    print(f"wrote {data['count']} properties ({ko} with Korean labels) → {os.path.abspath(OUT)}")

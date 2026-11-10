"""
Persistent knowledge base: accumulates generated graphs into one graph.

Each ingest is recorded as a *source* (topic + time). Nodes and edges keep
the set of sources they came from, which is both provenance ("which
generation said this?") and the unit of undo (removing a source deletes
what only it contributed).

Entity resolution when ingesting a node, in order:
  1. same Wikidata id                                   → same entity
  2. same normalized label or alias, compatible kind,
     and no conflicting Wikidata ids                    → same entity
  3. otherwise                                          → new entity
"Kind" is Class-like / Instance / Literal: a class and an individual that
share a name are not merged, and neither are two items with different
Wikidata ids (homonyms such as Mercury the planet and the element).

Storage is SQLite (stdlib), one file under the app data directory.
"""

from __future__ import annotations

import copy
import json
import os
import re
import sqlite3
import sys
import threading
import time
import uuid
from collections import deque
from typing import Any

import vocabulary as vocab

_APP_DIR = (os.path.dirname(sys.executable) if getattr(sys, "frozen", False)
            else os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PATH = os.path.join(_APP_DIR, "data", "knowledge.db")

# Edge fields worth keeping besides source/target/label.
EDGE_EXTRA = ("relation", "original_label", "wikidata", "super_relation", "super_inverse",
              "normalization_note")
NODE_EXTRA = ("wikidata_label", "wikidata_description")

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, type TEXT NOT NULL,
    description TEXT DEFAULT '', wikidata_id TEXT, properties TEXT DEFAULT '[]',
    extra TEXT DEFAULT '{}', created REAL, updated REAL);
CREATE INDEX IF NOT EXISTS nodes_wikidata ON nodes(wikidata_id);
CREATE TABLE IF NOT EXISTS aliases (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    alias_norm TEXT NOT NULL, alias TEXT NOT NULL, PRIMARY KEY (node_id, alias_norm));
CREATE INDEX IF NOT EXISTS aliases_norm ON aliases(alias_norm);
CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, label TEXT NOT NULL,
    extra TEXT DEFAULT '{}', created REAL, UNIQUE (source, label, target));
CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, topic TEXT, created REAL, node_count INTEGER, edge_count INTEGER);
CREATE TABLE IF NOT EXISTS node_sources (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    PRIMARY KEY (node_id, source_id));
CREATE TABLE IF NOT EXISTS edge_sources (
    edge_id TEXT NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    PRIMARY KEY (edge_id, source_id));
"""


def norm_label(text: str) -> str:
    return re.sub(r"[\s_\-·]+", " ", str(text or "").strip().lower())


def _kind(node_type: str | None) -> str:
    if node_type == "Instance":
        return "instance"
    if node_type == "Literal":
        return "literal"
    return "class"


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class KnowledgeBase:
    def __init__(self, path: str | None = None):
        self.path = path or os.getenv("AUTOLOGY_KB_PATH") or DEFAULT_PATH
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        self._lock = threading.Lock()
        with self._connect() as db:
            db.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        return db

    # ── Ingest ───────────────────────────────────────────────────────────

    def ingest(self, graph: dict[str, Any], topic: str = "") -> dict[str, Any]:
        """Merge a graph into the knowledge base. Returns what happened."""
        g = vocab.normalize_graph(copy.deepcopy(graph))
        now = time.time()
        source_id = _new_id("src")
        report = {"source_id": source_id, "nodes_added": 0, "nodes_merged": 0,
                  "edges_added": 0, "edges_existing": 0, "merges": [], "conflicts": []}
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO sources VALUES (?,?,?,?,?)",
                       (source_id, topic, now, len(g.get("nodes") or []), 0))
            id_map: dict[str, str] = {}
            for node in g.get("nodes") or []:
                if not node.get("label"):
                    continue
                match, reason = self._find_match(db, node)
                if match:
                    self._merge_node(db, match, node, now, report)
                    report["nodes_merged"] += 1
                    report["merges"].append({"label": node["label"], "into": match["label"],
                                             "id": match["id"], "reason": reason})
                    kb_id = match["id"]
                else:
                    kb_id = self._insert_node(db, node, now)
                    report["nodes_added"] += 1
                id_map[node.get("id")] = kb_id
                db.execute("INSERT OR IGNORE INTO node_sources VALUES (?,?)", (kb_id, source_id))

            edge_count = 0
            for edge in g.get("edges") or []:
                if edge.get("inferred"):
                    continue
                s, t = id_map.get(edge.get("source")), id_map.get(edge.get("target"))
                if not s or not t or s == t:
                    continue
                row = db.execute("SELECT id FROM edges WHERE source=? AND label=? AND target=?",
                                 (s, edge["label"], t)).fetchone()
                if row:
                    edge_id = row["id"]
                    report["edges_existing"] += 1
                else:
                    edge_id = _new_id("ke")
                    extra = {k: edge[k] for k in EDGE_EXTRA if k in edge}
                    db.execute("INSERT INTO edges VALUES (?,?,?,?,?,?)",
                               (edge_id, s, t, edge["label"], json.dumps(extra, ensure_ascii=False), now))
                    report["edges_added"] += 1
                db.execute("INSERT OR IGNORE INTO edge_sources VALUES (?,?)", (edge_id, source_id))
                edge_count += 1
            db.execute("UPDATE sources SET edge_count=? WHERE id=?", (edge_count, source_id))
        report["id_map"] = id_map
        return report

    def _find_match(self, db, node) -> tuple[sqlite3.Row | None, str]:
        wid = node.get("wikidata_id")
        if wid:
            row = db.execute("SELECT * FROM nodes WHERE wikidata_id=?", (wid,)).fetchone()
            if row:
                return row, f"wikidata:{wid}"
        rows = db.execute(
            "SELECT n.* FROM nodes n JOIN aliases a ON a.node_id = n.id WHERE a.alias_norm=?",
            (norm_label(node["label"]),)).fetchall()
        for row in rows:
            if _kind(row["type"]) != _kind(node.get("type")):
                continue
            if wid and row["wikidata_id"] and row["wikidata_id"] != wid:
                continue        # homonyms: same name, different Wikidata items
            return row, "label"
        return None, ""

    def _insert_node(self, db, node, now) -> str:
        kb_id = _new_id("kn")
        extra = {k: node[k] for k in NODE_EXTRA if k in node}
        db.execute("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?)", (
            kb_id, node["label"], node.get("type") or "Class", node.get("description") or "",
            node.get("wikidata_id"), json.dumps(node.get("properties") or [], ensure_ascii=False),
            json.dumps(extra, ensure_ascii=False), now, now))
        self._add_alias(db, kb_id, node["label"])
        return kb_id

    def _merge_node(self, db, row, node, now, report) -> None:
        updates: dict[str, Any] = {}
        if not row["wikidata_id"] and node.get("wikidata_id"):
            updates["wikidata_id"] = node["wikidata_id"]
            extra = json.loads(row["extra"] or "{}")
            extra.update({k: node[k] for k in NODE_EXTRA if k in node})
            updates["extra"] = json.dumps(extra, ensure_ascii=False)
        if not row["description"] and node.get("description"):
            updates["description"] = node["description"]
        props = json.loads(row["properties"] or "[]")
        known = {p.get("key"): p.get("value") for p in props if p.get("key")}
        changed = False
        for p in node.get("properties") or []:
            key, value = p.get("key"), p.get("value")
            if not key:
                continue
            if key not in known:
                props.append({"key": key, "value": value})
                known[key] = value
                changed = True
            elif str(known[key]) != str(value):
                report["conflicts"].append({"node": row["label"], "property": key,
                                            "existing": known[key], "incoming": value})
        if changed:
            updates["properties"] = json.dumps(props, ensure_ascii=False)
        if updates:
            updates["updated"] = now
            cols = ", ".join(f"{k}=?" for k in updates)
            db.execute(f"UPDATE nodes SET {cols} WHERE id=?", (*updates.values(), row["id"]))
        self._add_alias(db, row["id"], node["label"])

    @staticmethod
    def _add_alias(db, node_id, label) -> None:
        db.execute("INSERT OR IGNORE INTO aliases VALUES (?,?,?)", (node_id, norm_label(label), label))

    # ── Read ─────────────────────────────────────────────────────────────

    def stats(self) -> dict[str, int]:
        with self._connect() as db:
            q = lambda sql: db.execute(sql).fetchone()[0]  # noqa: E731
            return {"nodes": q("SELECT COUNT(*) FROM nodes"), "edges": q("SELECT COUNT(*) FROM edges"),
                    "sources": q("SELECT COUNT(*) FROM sources"),
                    "linked_nodes": q("SELECT COUNT(*) FROM nodes WHERE wikidata_id IS NOT NULL")}

    def sources(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            return [dict(r) for r in db.execute("SELECT * FROM sources ORDER BY created DESC")]

    def graph(self, node_ids: set[str] | None = None, limit: int = 2000) -> dict[str, Any]:
        """Whole graph (up to `limit` nodes) or the subgraph induced by node_ids."""
        with self._connect() as db:
            if node_ids is None:
                rows = db.execute("SELECT * FROM nodes ORDER BY created LIMIT ?", (limit,)).fetchall()
            else:
                ids = list(node_ids)[:limit]
                rows = db.execute(f"SELECT * FROM nodes WHERE id IN ({','.join('?' * len(ids))})",
                                  ids).fetchall() if ids else []
            keep = {r["id"] for r in rows}
            node_src = self._source_map(db, "node_sources", "node_id")
            edge_src = self._source_map(db, "edge_sources", "edge_id")
            aliases: dict[str, list[str]] = {}
            for a in db.execute("SELECT node_id, alias FROM aliases"):
                aliases.setdefault(a["node_id"], []).append(a["alias"])
            nodes = []
            for r in rows:
                n = {"id": r["id"], "label": r["label"], "type": r["type"],
                     "description": r["description"] or "",
                     "properties": json.loads(r["properties"] or "[]"),
                     "sources": node_src.get(r["id"], []),
                     "aliases": [a for a in aliases.get(r["id"], []) if a != r["label"]]}
                if r["wikidata_id"]:
                    n["wikidata_id"] = r["wikidata_id"]
                n.update(json.loads(r["extra"] or "{}"))
                nodes.append(n)
            edges = []
            for r in db.execute("SELECT * FROM edges"):
                if r["source"] in keep and r["target"] in keep:
                    e = {"id": r["id"], "source": r["source"], "target": r["target"],
                         "label": r["label"], "style": "solid", "inferred": False,
                         "sources": edge_src.get(r["id"], [])}
                    e.update(json.loads(r["extra"] or "{}"))
                    edges.append(e)
        return {"nodes": nodes, "edges": edges}

    @staticmethod
    def _source_map(db, table, col) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        for r in db.execute(f"SELECT t.{col} AS k, s.id, s.topic FROM {table} t "
                            f"JOIN sources s ON s.id = t.source_id"):
            out.setdefault(r["k"], []).append({"id": r["id"], "topic": r["topic"]})
        return out

    def search(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        q = norm_label(query)
        with self._connect() as db:
            rows = db.execute(
                "SELECT DISTINCT n.id, n.label, n.type, n.wikidata_id FROM nodes n "
                "JOIN aliases a ON a.node_id = n.id "
                "WHERE a.alias_norm LIKE ? OR n.wikidata_id = ? "
                "ORDER BY (a.alias_norm = ?) DESC, length(n.label) LIMIT ?",
                (f"%{q}%", query.strip(), q, limit)).fetchall()
        return [dict(r) for r in rows]

    def neighbourhood(self, seeds: list[str], hops: int = 1, limit: int = 500) -> dict[str, Any]:
        """Subgraph within `hops` edges (either direction) of the seed nodes."""
        with self._connect() as db:
            adj: dict[str, set[str]] = {}
            for r in db.execute("SELECT source, target FROM edges"):
                adj.setdefault(r["source"], set()).add(r["target"])
                adj.setdefault(r["target"], set()).add(r["source"])
        seen = set(seeds)
        frontier = deque((s, 0) for s in seeds)
        while frontier and len(seen) < limit:
            node, d = frontier.popleft()
            if d >= hops:
                continue
            for nb in adj.get(node, ()):
                if nb not in seen:
                    seen.add(nb)
                    frontier.append((nb, d + 1))
        return self.graph(seen, limit)

    # ── Undo / reset ─────────────────────────────────────────────────────

    def delete_source(self, source_id: str) -> dict[str, int]:
        """Remove one ingest; nodes/edges no other source supports are deleted."""
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM sources WHERE id=?", (source_id,))
            e = db.execute("DELETE FROM edges WHERE id NOT IN (SELECT edge_id FROM edge_sources)").rowcount
            n = db.execute("DELETE FROM nodes WHERE id NOT IN (SELECT node_id FROM node_sources)").rowcount
        return {"nodes_deleted": n, "edges_deleted": e}

    def reset(self) -> None:
        with self._lock, self._connect() as db:
            for table in ("edge_sources", "node_sources", "edges", "aliases", "nodes", "sources"):
                db.execute(f"DELETE FROM {table}")


_kb: KnowledgeBase | None = None


def get_kb() -> KnowledgeBase:
    global _kb
    if _kb is None:
        _kb = KnowledgeBase()
    return _kb

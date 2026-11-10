"""스모크 테스트 — 핵심 엔드포인트가 살아있는지 최소 검증.

실행:
    cd backend && ./venv/bin/python tests/test_smoke.py
    # pytest 설치 시:
    cd backend && ./venv/bin/pytest tests/

Ollama/네트워크 없이도 통과하도록 설계됨 — 자동 기동은 env로 비활성화하고,
값이 아니라 응답 형태(status code, 키 존재)만 단언한다.
"""
import os
import sys

# Ollama 자동 기동 비활성화 (테스트는 외부 의존성 없이 돌아야 함)
os.environ.setdefault("AUTOLOGY_SKIP_OLLAMA_AUTOSTART", "1")
# 실제 지식 베이스를 건드리지 않도록 임시 DB 사용
import tempfile  # noqa: E402
os.environ["AUTOLOGY_KB_PATH"] = os.path.join(tempfile.mkdtemp(), "kb.db")

# backend/ 를 import 경로에 추가
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402


def test_health():
    with TestClient(app) as client:
        r = client.get("/health")
    assert r.status_code == 200
    assert r.json().get("status") == "ok"


def test_ollama_status_shape():
    with TestClient(app) as client:
        r = client.get("/api/ollama/status")
    assert r.status_code == 200
    body = r.json()
    for key in ("installed", "running", "models"):
        assert key in body, f"missing key: {key}"


def test_semantic_capabilities():
    with TestClient(app) as client:
        r = client.get("/api/semantic/capabilities")
    assert r.status_code == 200
    assert r.json().get("rdflib") is True


def test_semantic_export_turtle():
    graph = {
        "nodes": [
            {"id": "n1", "label": "Person", "type": "Class",
             "x": 100, "y": 100, "properties": [], "description": ""},
            {"id": "n2", "label": "Alice", "type": "Instance",
             "x": 100, "y": 300, "properties": [], "description": ""},
        ],
        "edges": [
            {"id": "e1", "source": "n2", "target": "n1", "label": "is-a"},
        ],
    }
    with TestClient(app) as client:
        r = client.post("/api/semantic/export", json={"graph": graph, "format": "turtle"})
    assert r.status_code == 200
    assert r.json().get("content"), "export content is empty"


def test_semantic_reason():
    graph = {
        "nodes": [
            {"id": "a", "label": "A", "type": "Instance"},
            {"id": "b", "label": "B", "type": "Instance"},
            {"id": "c", "label": "C", "type": "Instance"},
        ],
        "edges": [
            {"id": "e1", "source": "a", "target": "b", "label": "part-of"},
            {"id": "e2", "source": "b", "target": "c", "label": "part-of"},
        ],
    }
    with TestClient(app) as client:
        r = client.post("/api/semantic/reason", json={"graph": graph})
    assert r.status_code == 200
    body = r.json()
    assert [(e["source"], e["target"]) for e in body["inferred"]] == [("a", "c")]
    assert "issues" in body and "stats" in body


def test_knowledge_endpoints():
    g1 = {"nodes": [{"id": "a", "label": "피스톤", "type": "Instance"},
                    {"id": "b", "label": "엔진", "type": "Instance"}],
          "edges": [{"id": "e", "source": "a", "target": "b", "label": "part-of"}]}
    g2 = {"nodes": [{"id": "a", "label": "엔진", "type": "Instance"},
                    {"id": "b", "label": "자동차", "type": "Instance"}],
          "edges": [{"id": "e", "source": "a", "target": "b", "label": "part-of"}]}
    with TestClient(app) as client:
        r1 = client.post("/api/knowledge/ingest", json={"graph": g1, "topic": "엔진"}).json()
        r2 = client.post("/api/knowledge/ingest", json={"graph": g2, "topic": "자동차"}).json()
        assert r1["nodes_added"] == 2 and r2["nodes_merged"] == 1
        stats = client.get("/api/knowledge/stats").json()
        assert stats["nodes"] == 3 and len(stats["sources"]) == 2
        sub = client.post("/api/knowledge/subgraph", json={"query": "피스톤", "hops": 2}).json()
        assert {n["label"] for n in sub["nodes"]} == {"피스톤", "엔진", "자동차"}
        # Path exploration over the knowledge base: 피스톤 part-of 자동차 is inferred
        # from two sources, and the answer cites both.
        paths = client.post("/api/explore/paths", json={"source": "피스톤", "target": "자동차"}).json()
        top = paths["paths"][0]
        assert top["hops"] == 1 and top["inferred_steps"] == 1
        assert sorted(s["topic"] for s in top["sources"]) == ["엔진", "자동차"]
        facts = client.post("/api/explore/facts", json={"node": "엔진", "graph": g1}).json()
        assert [f["statement"] for f in facts["facts"]] == ["피스톤 part-of 엔진"]
        assert client.post("/api/explore/facts", json={"node": "x", "direction": "up"}).status_code == 400
        assert client.delete(f"/api/knowledge/sources/{r2['source_id']}").json()["nodes_deleted"] == 1
        assert client.get("/api/knowledge/graph").json()["nodes"].__len__() == 2


def _run_all():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failures = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL  {t.__name__}: {exc}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return failures


if __name__ == "__main__":
    sys.exit(1 if _run_all() else 0)

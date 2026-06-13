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

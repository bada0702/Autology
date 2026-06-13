"""
Autology FastAPI Backend
Run: uvicorn main:app --reload --port 8000
"""

import asyncio
import json
import logging
import os
import sys
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict

# .env 로드 (선택적 검색 API 키, OLLAMA_BASE 등) — env를 읽는 다른 모듈 import 전에 실행
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from models.job import Job, JobStatus, AgentStatus
from crew.orchestrator import run_crew_pipeline
from memory.store import memory_store
from ollama_manager import ensure_ollama_running, ollama_installed, shutdown_ollama
from semantic import (
    SemanticUnavailable,
    parse_rdf_document,
    run_sparql,
    serialize_autology_graph,
    validate_shacl,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("autology")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """앱 기동/종료 훅 — Ollama 서버를 함께 띄우고 정리한다."""
    # escape hatch: AUTOLOGY_SKIP_OLLAMA_AUTOSTART 설정 시 자동 기동 생략 (테스트/수동 관리)
    if not os.getenv("AUTOLOGY_SKIP_OLLAMA_AUTOSTART"):
        # 블로킹 호출이므로 이벤트 루프를 막지 않도록 스레드에서 실행
        await asyncio.get_event_loop().run_in_executor(None, ensure_ollama_running)
    yield
    shutdown_ollama()


app = FastAPI(title="Autology CrewAI Backend", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job store
jobs: Dict[str, Job] = {}
# Active WebSocket connections per job
ws_connections: Dict[str, list] = {}


# ── Request / Response schemas ─────────────────────────────────────

class StartJobRequest(BaseModel):
    topic: str
    options: Dict[str, Any] = {}

class StartJobResponse(BaseModel):
    job_id: str

class SemanticExportRequest(BaseModel):
    graph: Dict[str, Any]
    format: str = "turtle"

class SemanticImportRequest(BaseModel):
    content: str
    format: str = "turtle"

class SparqlRequest(BaseModel):
    content: str
    query: str
    format: str = "turtle"

class ShaclRequest(BaseModel):
    data: str
    shapes: str
    data_format: str = "turtle"
    shapes_format: str = "turtle"


# ── REST endpoints ─────────────────────────────────────────────────

OLLAMA_BASE = os.getenv("OLLAMA_BASE", "http://localhost:11434")


def _ollama_target(request: Request) -> str:
    """요청 헤더(X-Ollama-Target)로 대상 Ollama 주소를 결정. 없으면 기본값."""
    return (request.headers.get("x-ollama-target") or OLLAMA_BASE).rstrip("/")


# ── Ollama 프록시 ────────────────────────────────────────────────────

@app.get("/ollama/api/tags")
async def ollama_tags(request: Request):
    """Ollama 설치 모델 목록 프록시 (CORS 우회)."""
    base = _ollama_target(request)
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{base}/api/tags")
            return r.json()
    except Exception as e:
        raise HTTPException(502, f"Ollama 연결 실패: {e}")


@app.post("/ollama/api/chat")
async def ollama_chat(request: Request):
    """Ollama /api/chat 프록시 — 스트리밍/비스트리밍 모두 지원."""
    base = _ollama_target(request)
    body = await request.body()
    try:
        is_streaming = json.loads(body).get("stream", False)
    except Exception:
        is_streaming = False

    if is_streaming:
        async def stream_gen():
            async with httpx.AsyncClient(timeout=300) as client:
                async with client.stream(
                    "POST", f"{base}/api/chat",
                    content=body,
                    headers={"Content-Type": "application/json"},
                ) as resp:
                    async for chunk in resp.aiter_bytes():
                        yield chunk

        return StreamingResponse(stream_gen(), media_type="application/x-ndjson")
    else:
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(
                f"{base}/api/chat",
                content=body,
                headers={"Content-Type": "application/json"},
            )
            return r.json()


# ── REST endpoints ─────────────────────────────────────────────────

@app.get("/api/ollama/status")
async def ollama_status(request: Request):
    """Ollama 설치/실행/모델 보유 상태를 보고 — 프론트엔드 안내 페이지용."""
    base = _ollama_target(request)
    installed = ollama_installed()
    running = False
    models: list = []
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{base}/api/tags")
            if r.status_code == 200:
                running = True
                models = [m.get("name") for m in r.json().get("models", []) if m.get("name")]
    except Exception:
        pass
    # 실행 중이면 설치된 것이 확실 (PATH 밖 설치로 binary 탐지 실패한 경우 보정)
    if running:
        installed = True
    return {"installed": installed, "running": running, "models": models}


@app.get("/health")
async def health():
    """Check server and Ollama availability."""
    ollama_ok = False
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get("http://localhost:11434/api/tags")
            ollama_ok = r.status_code == 200
    except Exception:
        pass
    return {"status": "ok", "ollama": ollama_ok}


@app.get("/api/semantic/capabilities")
async def semantic_capabilities():
    """Report availability of optional semantic-web engines."""
    caps = {"rdflib": False, "pyshacl": False}
    try:
        import rdflib  # noqa: F401
        caps["rdflib"] = True
    except Exception:
        pass
    try:
        import pyshacl  # noqa: F401
        caps["pyshacl"] = True
    except Exception:
        pass
    return caps


@app.post("/api/semantic/export")
async def semantic_export(req: SemanticExportRequest):
    """Serialize the Autology graph through RDFLib formats."""
    try:
        return {"content": serialize_autology_graph(req.graph, req.format), "format": req.format}
    except SemanticUnavailable as exc:
        raise HTTPException(503, str(exc))
    except Exception as exc:
        raise HTTPException(400, f"RDF export failed: {exc}")


@app.post("/api/semantic/import")
async def semantic_import(req: SemanticImportRequest):
    """Parse RDF/Turtle/RDF-XML/JSON-LD through RDFLib into Autology JSON."""
    try:
        return {"graph": parse_rdf_document(req.content, req.format)}
    except SemanticUnavailable as exc:
        raise HTTPException(503, str(exc))
    except Exception as exc:
        raise HTTPException(400, f"RDF import failed: {exc}")


@app.post("/api/semantic/sparql")
async def semantic_sparql(req: SparqlRequest):
    """Run a SPARQL SELECT query over an RDF document."""
    try:
        return run_sparql(req.content, req.query, req.format)
    except SemanticUnavailable as exc:
        raise HTTPException(503, str(exc))
    except Exception as exc:
        raise HTTPException(400, f"SPARQL failed: {exc}")


@app.post("/api/semantic/shacl")
async def semantic_shacl(req: ShaclRequest):
    """Validate a data graph with SHACL shapes via pySHACL."""
    try:
        return validate_shacl(req.data, req.shapes, req.data_format, req.shapes_format)
    except SemanticUnavailable as exc:
        raise HTTPException(503, str(exc))
    except Exception as exc:
        raise HTTPException(400, f"SHACL validation failed: {exc}")


@app.post("/api/crew/start", response_model=StartJobResponse)
async def start_job(req: StartJobRequest):
    if not req.topic.strip():
        raise HTTPException(400, "topic is required")

    job_id = str(uuid.uuid4())
    job = Job(id=job_id, topic=req.topic, options=req.options)
    jobs[job_id] = job
    ws_connections[job_id] = []

    async def broadcast(event: dict):
        dead = []
        for ws in ws_connections.get(job_id, []):
            try:
                await ws.send_text(json.dumps(event))
            except Exception:
                dead.append(ws)
        for ws in dead:
            ws_connections[job_id].remove(ws)

    asyncio.create_task(run_crew_pipeline(job, broadcast))
    return StartJobResponse(job_id=job_id)


@app.get("/api/crew/status/{job_id}")
async def get_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return {
        "job_id": job_id,
        "status": job.status,
        "agents": [a.model_dump() for a in job.agents],
        "error": job.error,
    }


@app.get("/api/crew/result/{job_id}")
async def get_result(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status != JobStatus.completed:
        raise HTTPException(202, "Job not completed yet")
    return {"job_id": job_id, "graph": job.result}


# ── WebSocket ──────────────────────────────────────────────────────

@app.websocket("/ws/crew/{job_id}")
async def websocket_endpoint(websocket: WebSocket, job_id: str):
    await websocket.accept()

    job = jobs.get(job_id)
    if not job:
        await websocket.send_text(json.dumps({"type": "error", "message": "Job not found"}))
        await websocket.close()
        return

    # Register connection
    if job_id not in ws_connections:
        ws_connections[job_id] = []
    ws_connections[job_id].append(websocket)

    # Send current state immediately
    await websocket.send_text(json.dumps({
        "type": "state",
        "status": job.status,
        "agents": [a.model_dump() for a in job.agents],
    }))

    try:
        while True:
            # Keep alive (client can send pings)
            data = await asyncio.wait_for(websocket.receive_text(), timeout=30)
            if data == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    finally:
        if job_id in ws_connections and websocket in ws_connections[job_id]:
            ws_connections[job_id].remove(websocket)


# ── Memory API ─────────────────────────────────────────────────────

class PatternCreateRequest(BaseModel):
    domain: str
    original: str
    corrected: str
    note: str = ""

class PatternIdPath(BaseModel):
    pattern_id: str


@app.get("/api/memory/patterns")
async def list_patterns(domain: str = ""):
    """List all learned correction patterns, optionally filtered by domain."""
    return {"patterns": memory_store.get_patterns(domain or None)}


@app.post("/api/memory/patterns")
async def create_pattern(req: PatternCreateRequest):
    """Record a new correction pattern (or increment count if duplicate)."""
    if not req.original.strip() or not req.corrected.strip():
        raise HTTPException(400, "original and corrected are required")
    pattern = memory_store.add_pattern(req.domain, req.original, req.corrected, req.note)
    return {"pattern": pattern}


@app.delete("/api/memory/patterns/{pattern_id}")
async def delete_pattern(pattern_id: str):
    """Delete a correction pattern by id."""
    if not memory_store.delete_pattern(pattern_id):
        raise HTTPException(404, "Pattern not found")
    return {"deleted": pattern_id}


@app.put("/api/memory/patterns/{pattern_id}/count")
async def increment_pattern(pattern_id: str):
    """Increment usage count for a pattern."""
    pattern = memory_store.increment_pattern(pattern_id)
    if not pattern:
        raise HTTPException(404, "Pattern not found")
    return {"pattern": pattern}


# ── 정적 프론트엔드 서빙 ────────────────────────────────────────────
# 빌드된 React 앱(dist/)을 동일 출처(127.0.0.1:8000)에서 서빙한다.
# 반드시 모든 API/WS 라우트가 등록된 *뒤*에 마운트해야 "/"가 API를 가리지 않는다.

def _dist_dir() -> str:
    """빌드된 프론트엔드(dist) 경로. PyInstaller 번들/개발 환경 모두 대응."""
    if getattr(sys, "frozen", False):
        # PyInstaller: spec에서 ('../dist', 'dist')로 번들 → _MEIPASS/dist
        base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    else:
        # backend/main.py → 프로젝트 루트 → dist
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "dist")


_DIST = _dist_dir()
if os.path.isdir(_DIST):
    # html=True: "/" 요청 시 index.html 반환 (SPA)
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="static")
    logger.info("프론트엔드 정적 서빙: %s", _DIST)
else:
    logger.warning(
        "dist 폴더를 찾을 수 없습니다 (%s). 프론트엔드는 `npm run dev`로 실행하세요.", _DIST
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

"""
Autology FastAPI Backend
Run: uvicorn main:app --reload --port 8000
"""

import asyncio
import json
import uuid
from typing import Any, Dict

import os
import sys
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from models.job import Job, JobStatus, AgentStatus
from crew.orchestrator import run_crew_pipeline
from semantic import (
    SemanticUnavailable,
    parse_rdf_document,
    run_sparql,
    serialize_autology_graph,
    validate_shacl,
)

app = FastAPI(title="Autology CrewAI Backend", version="1.0.0")

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

OLLAMA_BASE = "http://localhost:11434"


# ── Ollama 프록시 ────────────────────────────────────────────────────

@app.get("/ollama/api/tags")
async def ollama_tags():
    """Ollama 설치 모델 목록 프록시 (CORS 우회)."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{OLLAMA_BASE}/api/tags")
            return r.json()
    except Exception as e:
        raise HTTPException(502, f"Ollama 연결 실패: {e}")


@app.post("/ollama/api/chat")
async def ollama_chat(request: Request):
    """Ollama /api/chat 프록시 — 스트리밍/비스트리밍 모두 지원."""
    body = await request.body()
    try:
        is_streaming = json.loads(body).get("stream", False)
    except Exception:
        is_streaming = False

    if is_streaming:
        async def stream_gen():
            async with httpx.AsyncClient(timeout=300) as client:
                async with client.stream(
                    "POST", f"{OLLAMA_BASE}/api/chat",
                    content=body,
                    headers={"Content-Type": "application/json"},
                ) as resp:
                    async for chunk in resp.aiter_bytes():
                        yield chunk

        return StreamingResponse(stream_gen(), media_type="application/x-ndjson")
    else:
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(
                f"{OLLAMA_BASE}/api/chat",
                content=body,
                headers={"Content-Type": "application/json"},
            )
            return r.json()


# ── REST endpoints ─────────────────────────────────────────────────

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


# ── Ollama Generic Proxy ─────────────────────────────────────────────

@app.api_route("/ollama-proxy/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"])
async def ollama_proxy(path: str, request: Request):
    """
    프론트엔드가 요청하는 Ollama API를 중계합니다.
    Header의 X-Ollama-Target 값을 타겟 주소로 삼고, path로 요청을 전달합니다.
    """
    target_base = request.headers.get("x-ollama-target", "http://localhost:11434")
    url = f"{target_base.rstrip('/')}/{path}"
    
    # 전달받은 헤더 복사 및 호스트 헤더 정리
    headers = dict(request.headers)
    headers.pop("host", None)
    headers.pop("x-ollama-target", None)
    
    # 쿼리 파라미터 유지
    query_params = dict(request.query_params)
    
    # 바디 읽기
    body = await request.body()
    
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            is_streaming = False
            try:
                if body:
                    is_streaming = json.loads(body).get("stream", False)
            except Exception:
                pass
            
            if is_streaming:
                async def stream_gen():
                    async with client.stream(
                        request.method,
                        url,
                        params=query_params,
                        content=body,
                        headers=headers
                    ) as resp:
                        async for chunk in resp.aiter_bytes():
                            yield chunk
                return StreamingResponse(stream_gen(), media_type="application/x-ndjson")
            else:
                resp = await client.request(
                    request.method,
                    url,
                    params=query_params,
                    content=body,
                    headers=headers
                )
                return StreamingResponse(
                    [resp.content],
                    status_code=resp.status_code,
                    media_type=resp.headers.get("content-type", "application/json")
                )
    except Exception as e:
        raise HTTPException(502, f"Ollama 프록시 요청 실패: {e}")


# ── React Frontend Static Files Serving ──────────────────────────────

# PyInstaller 리소스 경로 탐색
if getattr(sys, 'frozen', False):
    base_path = sys._MEIPASS
else:
    base_path = os.path.dirname(os.path.abspath(__file__))

dist_path = os.path.join(base_path, "dist")
if not getattr(sys, 'frozen', False):
    dist_path = os.path.join(os.path.dirname(base_path), "dist")

if os.path.exists(dist_path):
    assets_dir = os.path.join(dist_path, "assets")
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")
    
    @app.get("/{catchall:path}")
    async def serve_spa(catchall: str):
        if catchall.startswith("api/") or catchall.startswith("ws/") or catchall.startswith("health") or catchall.startswith("ollama"):
            raise HTTPException(status_code=404)
        
        file_path = os.path.join(dist_path, catchall)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(dist_path, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

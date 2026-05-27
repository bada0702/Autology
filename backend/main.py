"""
Autology FastAPI Backend
Run: uvicorn main:app --reload --port 8000
"""

import asyncio
import json
import os
import uuid
from typing import Any, Dict

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from models.job import Job, JobStatus, AgentStatus
from crew.orchestrator import run_crew_pipeline
from memory.store import memory_store
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

OLLAMA_BASE = "http://127.0.0.1:11434"


def _normalize_target(url: str) -> str:
    """protocol 보완 + localhost → 127.0.0.1 (Windows IPv6 우선 해석 방지)."""
    url = url.strip().lstrip("/").rstrip("/")   # //localhost → localhost
    if not url.startswith(("http://", "https://")):
        url = "http://" + url
    return url.replace("://localhost", "://127.0.0.1")


# ── Ollama 범용 프록시 ────────────────────────────────────────────────
# X-Ollama-Target 헤더로 대상 URL 지정 (기본값: 127.0.0.1:11434)

@app.api_route("/api/ollama/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def ollama_proxy(path: str, request: Request):
    raw_header = request.headers.get("X-Ollama-Target", "")
    print(f"[OLLAMA DEBUG] raw header = {repr(raw_header)}")
    # 항상 로컬 Ollama 사용 (헤더 포맷 문제 우회)
    target = "http://127.0.0.1:11434"
    body = await request.body()
    content_type = request.headers.get("content-type", "application/json")

    is_streaming = False
    if body:
        try:
            is_streaming = json.loads(body).get("stream", False)
        except Exception:
            pass

    try:
        if is_streaming:
            async def stream_gen():
                async with httpx.AsyncClient(timeout=300) as client:
                    async with client.stream(
                        request.method, f"{target}/{path}",
                        content=body,
                        headers={"Content-Type": content_type},
                    ) as resp:
                        async for chunk in resp.aiter_bytes():
                            yield chunk
            return StreamingResponse(stream_gen(), media_type="application/x-ndjson")
        else:
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.request(
                    request.method, f"{target}/{path}",
                    content=body,
                    headers={"Content-Type": content_type},
                )
                return Response(
                    content=r.content,
                    status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"),
                )
    except Exception as e:
        import traceback
        print(f"[OLLAMA PROXY ERROR] target={target} path={path} error={type(e).__name__}: {e}")
        traceback.print_exc()
        raise HTTPException(502, f"Ollama 연결 실패: {e}")


# ── REST endpoints ─────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Check server and Ollama availability."""
    ollama_ok = False
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get("http://127.0.0.1:11434/api/tags")
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


# ── Static frontend serving (production / frozen mode) ─────────────

def _resolve_dist_dir() -> str | None:
    import sys as _sys
    if getattr(_sys, 'frozen', False):
        candidate = os.path.join(_sys._MEIPASS, 'dist')
    else:
        candidate = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'dist'))
    return candidate if os.path.isdir(candidate) else None

_dist_dir = _resolve_dist_dir()

if _dist_dir:
    _assets_dir = os.path.join(_dist_dir, 'assets')
    if os.path.isdir(_assets_dir):
        app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

    @app.get("/", include_in_schema=False)
    async def _serve_root():
        return FileResponse(os.path.join(_dist_dir, 'index.html'))

    @app.get("/{full_path:path}", include_in_schema=False)
    async def _serve_spa(full_path: str):
        # Static files (favicon, fonts, etc.)
        file_path = os.path.join(_dist_dir, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        # SPA fallback — let React Router handle the route
        return FileResponse(os.path.join(_dist_dir, 'index.html'))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

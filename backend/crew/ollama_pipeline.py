"""
Fallback pipeline using direct Ollama API calls (no crewai required).
Same 5-agent structure: Research → Extraction → Relation → Validation → Editor
"""

import json
import os
import re
import httpx
from models.job import Job, JobStatus, AgentStatus

OLLAMA_BASE  = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma4:31b-cloud")


async def _chat(system: str, user: str) -> str:
    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.post(
            f"{OLLAMA_BASE}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user",   "content": user},
                ],
                "stream": False,
            },
        )
        r.raise_for_status()
        return r.json().get("message", {}).get("content", "")


def _extract_json(text: str) -> dict | None:
    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    return None


GRAPH_SCHEMA = """{
  "nodes": [{"id":"n1","label":"EntityName","type":"Class","x":200,"y":100,"properties":[],"description":""}],
  "edges": [{"id":"e1","source":"n1","target":"n2","label":"relationship","style":"solid","inferred":false}]
}"""


async def run_ollama_pipeline(job: Job, broadcast) -> None:
    topic   = job.topic
    options = job.options
    lang    = options.get("language", "Korean")
    max_n   = options.get("max_nodes", 25)

    async def notify(idx, status, msg="", preview=""):
        job.agents[idx].status  = status
        job.agents[idx].message = msg
        if preview:
            job.agents[idx].output_preview = preview[:300]
        await broadcast({"type": "agent_update", "agent_index": idx,
                         "status": status.value, "message": msg,
                         "preview": preview[:300] if preview else ""})

    try:
        job.status = JobStatus.running

        # ── Agent 0: Research ──────────────────────────────────────
        await notify(0, AgentStatus.running, "리서치 중...")

        # Try web search; fall back to LLM knowledge
        research_text = ""
        try:
            from .tools.search import search_web
            research_text = search_web(topic, 6)
        except Exception:
            pass

        if not research_text or research_text.startswith("No web search"):
            sys0 = f"당신은 전문 리서처입니다. 주어진 주제에 대해 핵심 개념, 엔티티, 관계를 {lang}로 상세히 설명하세요."
            research_text = await _chat(sys0, f"주제: {topic}")

        await notify(0, AgentStatus.done, "리서치 완료", research_text)

        # ── Agent 1: Extraction ───────────────────────────────────
        await notify(1, AgentStatus.running, "엔티티 추출 중...")
        sys1 = (
            f"당신은 온톨로지 엔지니어입니다. 텍스트에서 {max_n}개 이상의 엔티티를 빠짐없이 추출하세요. "
            "Class(추상 개념), Instance(구체 개체), Literal(값)로 분류하세요. "
            "JSON 배열만 반환하세요: [{\"id\":\"n1\",\"label\":\"...\",\"type\":\"Class\",\"description\":\"...\",\"properties\":[]}]"
        )
        research_budget = max(4000, max_n * 80)
        node_budget    = max(3000, max_n * 60)
        edge_budget    = max(2000, max_n * 40)
        nodes_text = await _chat(sys1, f"리서치 텍스트:\n{research_text[:research_budget]}")
        await notify(1, AgentStatus.done, "엔티티 추출 완료", nodes_text)

        # ── Agent 2: Relation ─────────────────────────────────────
        await notify(2, AgentStatus.running, "관계 분석 중...")
        sys2 = (
            "당신은 지식 그래프 전문가입니다. 추출된 노드 간 의미 있는 관계를 분석하세요. "
            "JSON 배열만 반환하세요: [{\"id\":\"e1\",\"source\":\"n1\",\"target\":\"n2\",\"label\":\"is-a\",\"style\":\"solid\",\"inferred\":false}]"
        )
        edges_text = await _chat(sys2, f"노드:\n{nodes_text[:node_budget]}\n\n리서치:\n{research_text[:2000]}")
        await notify(2, AgentStatus.done, "관계 분석 완료", edges_text)

        # ── Agent 3: Validation ───────────────────────────────────
        await notify(3, AgentStatus.running, "검증 중...")
        sys3 = (
            "당신은 온톨로지 QA 전문가입니다. 노드와 엣지를 검토하고 품질 점수와 주요 문제점을 JSON으로 반환하세요. "
            "{\"quality_score\":85,\"issues\":[],\"fixes\":[]}"
        )
        validation_text = await _chat(sys3, f"노드:\n{nodes_text[:node_budget]}\n엣지:\n{edges_text[:edge_budget]}")
        await notify(3, AgentStatus.done, "검증 완료", validation_text)

        # ── Agent 4: Editor ───────────────────────────────────────
        await notify(4, AgentStatus.running, "최종 그래프 생성 중...")
        x_max = max(1200, max_n * 20)
        y_max = max(800,  max_n * 12)
        sys4 = (
            f"당신은 온톨로지 에디터입니다. 아래 정보를 종합해 '{topic}'의 최종 그래프 JSON을 생성하세요. "
            f"노드 수 제한 없이 추출된 엔티티를 모두 포함하세요 (목표: {max_n}개 이상도 가능). "
            f"x: 100-{x_max}, y: 100-{y_max} 범위에 균등 배치. "
            "Class는 y 낮게, Instance는 중간, Literal은 y 높게. "
            f"반드시 {lang}로 레이블 작성. 설명 없이 JSON만 반환:\n{GRAPH_SCHEMA}"
        )
        final_text = await _chat(
            sys4,
            f"노드:\n{nodes_text[:node_budget]}\n엣지:\n{edges_text[:edge_budget]}\n검증:\n{validation_text[:500]}"
        )
        await notify(4, AgentStatus.done, "그래프 생성 완료", final_text)

        # ── Parse & finish ─────────────────────────────────────────
        graph = _extract_json(final_text) or {"nodes": [], "edges": []}
        job.result = graph
        job.status = JobStatus.completed
        await broadcast({"type": "completed", "graph": graph})

    except Exception as exc:
        job.status = JobStatus.failed
        job.error  = str(exc)
        await broadcast({"type": "error", "message": str(exc)})

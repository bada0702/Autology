"""
Fallback pipeline using direct Ollama API calls (no crewai required).

Pipeline: Research(0) → Extraction+Schema(1) → Relation+Memory(2) → Validation(3)
          → Editor(4) → [Critic(5) → Editor refinement loop (max 2 iter)]

New features:
  1. Cross-Verification: Critic Agent (5) reviews final JSON; triggers refinement if score < 80
  2. Dynamic Schema Evolution: Extraction step proposes new node types if domain requires them
  3. KGRAG evidence paths: surfaced via graph metadata (consumed by frontend)
  4. Long-term Memory: Relation Agent receives injected correction patterns from MemoryStore
"""

import json
import os
import re
import httpx
from models.job import Job, JobStatus, AgentStatus
from memory.store import memory_store

OLLAMA_BASE  = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma4:31b-cloud")

MAX_REFINEMENT_ITER = 2   # Maximum critic→editor refinement cycles


async def _chat(system: str, user: str) -> str:
    async with httpx.AsyncClient(timeout=180) as client:
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
    # Try fenced block first
    fenced = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if fenced:
        try:
            return json.loads(fenced.group(1).strip())
        except json.JSONDecodeError:
            pass
    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    return None


def _extract_json_array(text: str) -> list | None:
    fenced = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if fenced:
        try:
            return json.loads(fenced.group(1).strip())
        except json.JSONDecodeError:
            pass
    match = re.search(r'\[[\s\S]*\]', text)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    return None


GRAPH_SCHEMA = """{
  "nodes": [{"id":"n1","label":"EntityName","type":"Class","x":200,"y":100,"properties":[],"description":""}],
  "edges": [{"id":"e1","source":"n1","target":"n2","label":"relationship","style":"solid","inferred":false}],
  "schema_evolution": [],
  "memory_applied": []
}"""

CRITIC_SCHEMA = """{
  "quality_score": 85,
  "issues": [{"type":"circular_dependency","description":"...","affected_ids":[]}],
  "refinements": [{"action":"remove_edge","edge_id":"e1","reason":"..."}],
  "approved": true
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

        research_budget = max(4000, max_n * 80)
        node_budget     = max(3000, max_n * 60)
        edge_budget     = max(2000, max_n * 40)
        x_max = max(1200, max_n * 20)
        y_max = max(800,  max_n * 12)

        # ── Agent 0: Research ──────────────────────────────────────
        await notify(0, AgentStatus.running, "리서치 중...")

        research_text = ""
        try:
            from .tools.search import search_web
            research_text = search_web(topic, 6)
        except Exception:
            pass

        if not research_text or research_text.startswith("No web search"):
            sys0 = (
                f"당신은 전문 리서처입니다. "
                f"'{topic}'에 대해 핵심 개념, 엔티티, 관계를 {lang}로 상세히 설명하세요."
            )
            research_text = await _chat(sys0, f"주제: {topic}")

        await notify(0, AgentStatus.done, "리서치 완료", research_text)

        # ── Agent 1: Extraction + Schema Evolution ────────────────
        await notify(1, AgentStatus.running, "엔티티 추출 및 스키마 분석 중...")
        sys1 = (
            f"당신은 온톨로지 엔지니어입니다. 텍스트에서 {max_n}개 이상의 엔티티를 추출하세요.\n"
            "Class(추상 개념), Instance(구체 개체), Literal(값)로 분류하세요.\n\n"
            "추가로, 이 도메인의 특수성을 고려해 기본 3계층(Class/Instance/Literal) 외에 "
            "추가 타입이 필요하다면 schema_evolution에 제안하세요.\n\n"
            "반드시 아래 JSON 형식으로만 반환:\n"
            "{\n"
            '  "nodes": [{"id":"n1","label":"...","type":"Class","description":"...","properties":[]}],\n'
            '  "schema_evolution": [{"type":"SubClass","rationale":"...","example_nodes":["..."]}]\n'
            "}"
        )
        extraction_raw = await _chat(sys1, f"리서치 텍스트:\n{research_text[:research_budget]}")
        extraction_parsed = _extract_json(extraction_raw)
        nodes_list = []
        schema_evolution = []
        if extraction_parsed:
            nodes_list = extraction_parsed.get("nodes", [])
            schema_evolution = extraction_parsed.get("schema_evolution", [])
            nodes_text = json.dumps(nodes_list, ensure_ascii=False)
        else:
            nodes_text = extraction_raw
        await notify(1, AgentStatus.done,
                     f"엔티티 추출 완료 ({len(nodes_list)}개)" + (f" | 스키마 제안 {len(schema_evolution)}건" if schema_evolution else ""),
                     nodes_text[:300])

        # ── Agent 2: Relation + Memory Injection ──────────────────
        await notify(2, AgentStatus.running, "관계 분석 중 (장기 기억 적용)...")

        memory_context = memory_store.build_prompt_context(topic)
        memory_applied = []
        sys2 = (
            "당신은 지식 그래프 전문가입니다. 추출된 노드 간 의미 있는 관계를 분석하세요.\n"
            + (f"\n{memory_context}\n" if memory_context else "")
            + "JSON 배열만 반환하세요: "
            '[{"id":"e1","source":"n1","target":"n2","label":"is-a","style":"solid","inferred":false}]'
        )
        edges_text = await _chat(sys2, f"노드:\n{nodes_text[:node_budget]}\n\n리서치:\n{research_text[:2000]}")

        if memory_context:
            patterns = memory_store.get_patterns(topic)
            memory_applied = [{"pattern_id": p["id"], "domain": p["domain"],
                               "original": p["original"], "corrected": p["corrected"]}
                              for p in patterns[:5]]
            for p in patterns[:5]:
                memory_store.increment_pattern(p["id"])

        await notify(2, AgentStatus.done,
                     "관계 분석 완료" + (f" | 기억 패턴 {len(memory_applied)}개 적용" if memory_applied else ""),
                     edges_text[:300])

        # ── Agent 3: Validation ───────────────────────────────────
        await notify(3, AgentStatus.running, "검증 중...")
        sys3 = (
            "당신은 온톨로지 QA 전문가입니다. 노드와 엣지를 검토하고 품질 점수와 주요 문제점을 JSON으로 반환하세요. "
            '{"quality_score":85,"issues":[],"fixes":[]}'
        )
        validation_text = await _chat(sys3, f"노드:\n{nodes_text[:node_budget]}\n엣지:\n{edges_text[:edge_budget]}")
        await notify(3, AgentStatus.done, "검증 완료", validation_text[:300])

        # ── Agent 4: Editor ───────────────────────────────────────
        await notify(4, AgentStatus.running, "최종 그래프 생성 중...")

        schema_hint = ""
        if schema_evolution:
            extra_types = ", ".join(s["type"] for s in schema_evolution)
            schema_hint = f"\n제안된 추가 타입({extra_types})이 필요한 노드에는 해당 type을 적용하세요."

        sys4 = (
            f"당신은 온톨로지 에디터입니다. 아래 정보를 종합해 '{topic}'의 최종 그래프 JSON을 생성하세요.\n"
            f"노드 목표: {max_n}개 이상. x: 100-{x_max}, y: 100-{y_max} 범위 균등 배치.\n"
            "Class는 y 낮게, Instance는 중간, Literal은 y 높게."
            f"{schema_hint}\n"
            f"반드시 {lang}로 레이블. 설명 없이 JSON만 반환:\n{GRAPH_SCHEMA}"
        )
        final_text = await _chat(
            sys4,
            f"노드:\n{nodes_text[:node_budget]}\n엣지:\n{edges_text[:edge_budget]}\n검증:\n{validation_text[:500]}"
        )
        await notify(4, AgentStatus.done, "그래프 생성 완료", final_text[:300])

        # ── Agent 5: Critic + Refinement Loop ─────────────────────
        await notify(5, AgentStatus.running, "교차 검증 중...")

        current_graph_text = final_text
        graph = _extract_json(current_graph_text) or {"nodes": [], "edges": []}

        for iteration in range(MAX_REFINEMENT_ITER):
            sys_critic = (
                f"당신은 온톨로지 비판 에이전트입니다. '{topic}' 그래프를 교차 검증하세요.\n"
                "검사 항목:\n"
                "1) 순환 의존성 (A→B→A 순환)\n"
                "2) 타입 불일치 (Literal→Literal 엣지, 추상 개념이 값으로 사용)\n"
                "3) 논리적 모순 (같은 엔티티에 상충하는 관계)\n"
                "4) 의미론적 공백 (도메인 핵심 개념 누락)\n"
                "5) 고립된 서브그래프\n\n"
                f"반드시 아래 JSON 스키마로만 반환:\n{CRITIC_SCHEMA}"
            )
            critic_text = await _chat(
                sys_critic,
                f"그래프 JSON:\n{json.dumps(graph, ensure_ascii=False)[:3000]}"
            )
            critic_result = _extract_json(critic_text) or {}
            quality_score = critic_result.get("quality_score", 100)
            approved      = critic_result.get("approved", True)
            issues        = critic_result.get("issues", [])
            refinements   = critic_result.get("refinements", [])

            if approved or quality_score >= 80 or iteration == MAX_REFINEMENT_ITER - 1:
                await notify(5, AgentStatus.done,
                             f"검증 완료 — 품질 점수 {quality_score}/100 ({len(issues)}건 이슈)",
                             critic_text[:300])
                break
            else:
                # Trigger refinement: re-run Editor with critic feedback
                iter_num = iteration + 1
                await notify(5, AgentStatus.running,
                             f"품질 점수 {quality_score} — 정제 루프 {iter_num}회 실행 중...")
                refinement_prompt = (
                    f"비판 에이전트 피드백:\n"
                    f"품질 점수: {quality_score}/100\n"
                    f"문제점:\n" + "\n".join(f"  - {iss['description']}" for iss in issues[:5]) + "\n"
                    f"수정 지시:\n" + "\n".join(
                        f"  - {r['action']}: {r.get('reason','')}" for r in refinements[:5]
                    ) + "\n\n위 피드백을 반영하여 그래프를 수정하세요. JSON만 반환:\n{GRAPH_SCHEMA}"
                )
                refined_text = await _chat(
                    f"당신은 온톨로지 에디터입니다. 비판 에이전트의 피드백으로 그래프를 정제하세요. {schema_hint}",
                    f"현재 그래프:\n{json.dumps(graph, ensure_ascii=False)[:2000]}\n\n{refinement_prompt}"
                )
                refined = _extract_json(refined_text)
                if refined and refined.get("nodes"):
                    graph = refined
                    current_graph_text = refined_text

        # ── Attach metadata ───────────────────────────────────────
        graph["schema_evolution"] = schema_evolution
        graph["memory_applied"]   = memory_applied

        job.result = graph
        job.status = JobStatus.completed
        await broadcast({"type": "completed", "graph": graph})

    except Exception as exc:
        job.status = JobStatus.failed
        job.error  = str(exc)
        await broadcast({"type": "error", "message": str(exc)})

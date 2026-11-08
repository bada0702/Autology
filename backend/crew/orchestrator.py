"""Crew orchestrator: uses CrewAI if available, falls back to direct Ollama calls."""

import asyncio
import json
import re
from models.job import Job, JobStatus, AgentStatus

try:
    from crewai import Crew, Process
    from crew.agents import (
        make_extraction_agent, make_relation_agent,
        make_validation_agent, make_editor_agent, make_critic_agent,
    )
    from crew.tasks import (
        make_extraction_task, make_relation_task,
        make_validation_task, make_editor_task, make_critic_task,
    )
    CREWAI_AVAILABLE = True
except ImportError:
    CREWAI_AVAILABLE = False

MAX_REFINEMENT_ITER = 2
RESEARCH_BUDGET = 12000   # chars of research text handed to extraction


async def run_crew_pipeline(job: Job, broadcast) -> None:
    """Route to CrewAI pipeline or Ollama fallback based on availability."""
    if not CREWAI_AVAILABLE:
        from crew.ollama_pipeline import run_ollama_pipeline
        await run_ollama_pipeline(job, broadcast)
        return
    await _run_crewai_pipeline(job, broadcast)


def _kickoff(agent, task, inputs: dict) -> str:
    """Run one task in its own Crew. All data must arrive via `inputs`
    placeholders; see crew/tasks.py."""
    crew = Crew(agents=[agent], tasks=[task], process=Process.sequential, verbose=False)
    return str(crew.kickoff(inputs=inputs))


async def _run_crewai_pipeline(job: Job, broadcast) -> None:
    """CrewAI pipeline: research → extraction → relation → validation → editor → critic loop."""
    from .tools.search import search_web
    from memory.store import memory_store
    from reasoning import analyze, issues_for_prompt

    topic    = job.topic
    options  = job.options
    language = options.get("language", "Korean")
    loop     = asyncio.get_event_loop()

    async def notify(idx, status, msg="", preview=""):
        job.agents[idx].status  = status
        job.agents[idx].message = msg
        if preview:
            job.agents[idx].output_preview = preview[:300]
        await broadcast({
            "type": "agent_update",
            "agent_index": idx,
            "status": status.value,
            "message": msg,
            "preview": preview[:300] if preview else "",
        })

    async def run(agent, task, inputs):
        base = {"topic": topic, "language": language}
        return await loop.run_in_executor(None, _kickoff, agent, task, {**base, **inputs})

    try:
        job.status = JobStatus.running

        # ── Agent 0: Research (direct search, no LLM) ─────────────
        await notify(0, AgentStatus.running, "인터넷 리서치 중...")
        raw_text = await loop.run_in_executor(None, search_web, topic, 8)
        await notify(0, AgentStatus.done, "리서치 완료", raw_text)

        # ── Agent 1: Extraction ───────────────────────────────────
        await notify(1, AgentStatus.running, "엔티티 추출 중...")
        extraction_agent = make_extraction_agent()
        nodes_text = await run(
            extraction_agent,
            make_extraction_task(extraction_agent, options.get("max_nodes", 30)),
            {"research_output": (raw_text or "(no research text found)")[:RESEARCH_BUDGET]},
        )
        await notify(1, AgentStatus.done, "엔티티 추출 완료", nodes_text)

        # ── Agent 2: Relation (+ long-term memory patterns) ───────
        await notify(2, AgentStatus.running, "관계 분석 중...")
        memory_context = memory_store.build_prompt_context(topic)
        relation_agent = make_relation_agent()
        edges_text = await run(
            relation_agent, make_relation_task(relation_agent),
            {"nodes": nodes_text, "memory_context": memory_context or ""},
        )
        memory_applied = []
        if memory_context:
            patterns = memory_store.get_patterns(topic)[:5]
            memory_applied = [{"pattern_id": p["id"], "domain": p["domain"],
                               "original": p["original"], "corrected": p["corrected"]}
                              for p in patterns]
            for p in patterns:
                memory_store.increment_pattern(p["id"])
        await notify(2, AgentStatus.done,
                     "관계 분석 완료" + (f" | 기억 패턴 {len(memory_applied)}개 적용" if memory_applied else ""),
                     edges_text)

        # ── Agent 3: Validation ───────────────────────────────────
        await notify(3, AgentStatus.running, "구조 검증 중...")
        validation_agent = make_validation_agent()
        validation_text = await run(
            validation_agent, make_validation_task(validation_agent),
            {"nodes": nodes_text, "edges": edges_text},
        )
        await notify(3, AgentStatus.done, "검증 완료", validation_text)

        # ── Agent 4: Editor ───────────────────────────────────────
        await notify(4, AgentStatus.running, "최종 JSON 생성 중...")
        editor_agent = make_editor_agent()
        editor_inputs = {"nodes": nodes_text, "edges": edges_text}
        editor_text = await run(
            editor_agent, make_editor_task(editor_agent),
            {**editor_inputs, "validation": validation_text, "current_graph": "(none)"},
        )
        current_graph = _parse_graph(editor_text)
        await notify(4, AgentStatus.done, "JSON 생성 완료", editor_text)

        # ── Agent 5: Critic (cross-verification + refinement) ─────
        await notify(5, AgentStatus.running, "교차 검증 중...")
        critic_agent = make_critic_agent()

        for iteration in range(MAX_REFINEMENT_ITER):
            graph_json = json.dumps(current_graph, ensure_ascii=False)[:3000]
            rule_issues = issues_for_prompt(analyze(current_graph)["issues"])
            critic_text = await run(
                critic_agent, make_critic_task(critic_agent),
                {"graph_json": graph_json, "rule_issues": rule_issues or "(none)"},
            )
            critic_data = _parse_json_object(critic_text)
            quality_score = critic_data.get("quality_score", 100)
            approved      = critic_data.get("approved", True)
            issues        = critic_data.get("issues", [])

            if approved or quality_score >= 80 or iteration == MAX_REFINEMENT_ITER - 1:
                await notify(5, AgentStatus.done,
                             f"검증 완료 — 품질 점수 {quality_score}/100 ({len(issues)}건 이슈)",
                             critic_text)
                break

            await notify(5, AgentStatus.running,
                         f"품질 점수 {quality_score} — 정제 루프 {iteration + 1}회 시작...")
            refinements = critic_data.get("refinements", [])
            feedback = (
                f"비판 피드백 (품질 {quality_score}/100):\n"
                + "\n".join(f"- {iss.get('description', '')}" for iss in issues[:5]) + "\n"
                + "수정 지시:\n"
                + "\n".join(f"- {r.get('action', '')}: {r.get('reason', '')}" for r in refinements[:5])
                + (f"\n규칙 기반 검증기가 확정한 문제(반드시 반영):\n{rule_issues}" if rule_issues else "")
            )
            refined_text = await run(
                editor_agent, make_editor_task(editor_agent),
                {**editor_inputs, "validation": feedback, "current_graph": graph_json},
            )
            refined_graph = _parse_graph(refined_text)
            if refined_graph.get("nodes"):
                current_graph = refined_graph

        from crew.ollama_pipeline import finalize_graph
        await finalize_graph(current_graph, topic, options)
        current_graph["schema_evolution"] = []
        current_graph["memory_applied"]   = memory_applied

        job.result = current_graph
        job.status = JobStatus.completed
        await broadcast({"type": "completed", "graph": current_graph})

    except Exception as exc:
        job.status = JobStatus.failed
        job.error  = str(exc)
        await broadcast({"type": "error", "message": str(exc)})


def _parse_json_object(text: str) -> dict:
    match = re.search(r'\{[\s\S]*\}', text or "")
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    return {}


def _parse_graph(text: str) -> dict:
    """Extract JSON from LLM output."""
    graph = _parse_json_object(text)
    if graph:
        graph.setdefault("nodes", [])
        graph.setdefault("edges", [])
        return graph
    return {"nodes": [], "edges": [], "error": "Failed to parse graph JSON"}

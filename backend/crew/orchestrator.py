"""Crew orchestrator: uses CrewAI if available, falls back to direct Ollama calls."""

import asyncio
import json
import re
from models.job import Job, JobStatus, AgentStatus

try:
    from crewai import Crew, Process
    from crew.agents import (
        make_research_agent, make_extraction_agent, make_relation_agent,
        make_validation_agent, make_editor_agent,
    )
    from crew.tasks import (
        make_research_task, make_extraction_task, make_relation_task,
        make_validation_task, make_editor_task,
    )
    CREWAI_AVAILABLE = True
except ImportError:
    CREWAI_AVAILABLE = False


async def run_crew_pipeline(job: Job, broadcast) -> None:
    """Route to CrewAI pipeline or Ollama fallback based on availability."""
    if not CREWAI_AVAILABLE:
        from crew.ollama_pipeline import run_ollama_pipeline
        await run_ollama_pipeline(job, broadcast)
        return
    await _run_crewai_pipeline(job, broadcast)


async def _run_crewai_pipeline(job: Job, broadcast) -> None:
    """Full CrewAI 5-agent pipeline (requires crewai package)."""
    from .tools.search import search_web
    topic   = job.topic
    options = job.options

    def _set_agent(idx, status, message="", preview=""):
        job.agents[idx].status  = status
        job.agents[idx].message = message
        if preview:
            job.agents[idx].output_preview = preview[:300]

    async def notify(idx, status, msg="", preview=""):
        _set_agent(idx, status, msg, preview)
        await broadcast({
            "type": "agent_update",
            "agent_index": idx,
            "status": status.value,
            "message": msg,
            "preview": preview[:300] if preview else "",
        })

    try:
        job.status = JobStatus.running

        # ── Agent 0: Research ─────────────────────────────────────
        await notify(0, AgentStatus.running, "인터넷 리서치 중...")
        loop = asyncio.get_event_loop()
        raw_text = await loop.run_in_executor(None, search_web, topic, 8)
        await notify(0, AgentStatus.done, "리서치 완료", raw_text)

        # ── Agent 1: Extraction ───────────────────────────────────
        await notify(1, AgentStatus.running, "엔티티 추출 중...")
        research_agent   = make_research_agent()
        extraction_agent = make_extraction_agent()
        max_nodes = options.get("max_nodes", 30)

        research_task   = make_research_task(research_agent, topic, options)
        extraction_task = make_extraction_task(extraction_agent, research_task, max_nodes)

        # Override research task output with our pre-fetched text to save LLM calls
        research_task_result = raw_text

        extraction_crew = Crew(
            agents=[extraction_agent],
            tasks=[extraction_task],
            process=Process.sequential,
            verbose=False,
        )
        extraction_result = await loop.run_in_executor(
            None,
            lambda: extraction_crew.kickoff(inputs={"research_output": raw_text, "topic": topic}),
        )
        nodes_text = str(extraction_result)
        await notify(1, AgentStatus.done, "엔티티 추출 완료", nodes_text)

        # ── Agent 2: Relation ─────────────────────────────────────
        await notify(2, AgentStatus.running, "관계 분석 중...")
        relation_agent = make_relation_agent()
        relation_task  = make_relation_task(relation_agent, extraction_task)

        relation_crew = Crew(
            agents=[relation_agent],
            tasks=[relation_task],
            process=Process.sequential,
            verbose=False,
        )
        relation_result = await loop.run_in_executor(
            None,
            lambda: relation_crew.kickoff(inputs={"nodes": nodes_text, "topic": topic}),
        )
        edges_text = str(relation_result)
        await notify(2, AgentStatus.done, "관계 분석 완료", edges_text)

        # ── Agent 3: Validation ───────────────────────────────────
        await notify(3, AgentStatus.running, "구조 검증 중...")
        validation_agent = make_validation_agent()
        validation_task  = make_validation_task(validation_agent, extraction_task, relation_task)

        validation_crew = Crew(
            agents=[validation_agent],
            tasks=[validation_task],
            process=Process.sequential,
            verbose=False,
        )
        validation_result = await loop.run_in_executor(
            None,
            lambda: validation_crew.kickoff(
                inputs={"nodes": nodes_text, "edges": edges_text, "topic": topic}
            ),
        )
        validation_text = str(validation_result)
        await notify(3, AgentStatus.done, "검증 완료", validation_text)

        # ── Agent 4: Editor ───────────────────────────────────────
        await notify(4, AgentStatus.running, "최종 JSON 생성 중...")
        editor_agent = make_editor_agent()
        editor_task  = make_editor_task(
            editor_agent, extraction_task, relation_task, validation_task, topic
        )

        editor_crew = Crew(
            agents=[editor_agent],
            tasks=[editor_task],
            process=Process.sequential,
            verbose=False,
        )
        editor_result = await loop.run_in_executor(
            None,
            lambda: editor_crew.kickoff(
                inputs={
                    "nodes": nodes_text,
                    "edges": edges_text,
                    "validation": validation_text,
                    "topic": topic,
                }
            ),
        )
        editor_text = str(editor_result)
        await notify(4, AgentStatus.done, "JSON 생성 완료", editor_text)

        # ── Parse final graph ─────────────────────────────────────
        graph = _parse_graph(editor_text)
        job.result = graph
        job.status = JobStatus.completed
        await broadcast({"type": "completed", "graph": graph})

    except Exception as exc:
        job.status = JobStatus.failed
        job.error  = str(exc)
        await broadcast({"type": "error", "message": str(exc)})


def _parse_graph(text: str) -> dict:
    """Extract JSON from LLM output."""
    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    return {"nodes": [], "edges": [], "error": "Failed to parse graph JSON"}

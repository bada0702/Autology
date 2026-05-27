"""Crew orchestrator: uses CrewAI if available, falls back to direct Ollama calls."""

import asyncio
import json
import re
from models.job import Job, JobStatus, AgentStatus

try:
    from crewai import Crew, Process
    from crew.agents import (
        make_research_agent, make_extraction_agent, make_relation_agent,
        make_validation_agent, make_editor_agent, make_critic_agent,
    )
    from crew.tasks import (
        make_research_task, make_extraction_task, make_relation_task,
        make_validation_task, make_editor_task, make_critic_task,
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
    from memory.store import memory_store
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
        loop = asyncio.get_running_loop()
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

        # ── Agent 5: Critic (cross-verification + refinement) ─────
        await notify(5, AgentStatus.running, "교차 검증 중...")
        critic_agent = make_critic_agent()
        critic_task  = make_critic_task(critic_agent, editor_task, topic)

        import json as _json
        MAX_ITER = 2
        current_editor_text = editor_text
        current_graph = _parse_graph(current_editor_text)

        for iteration in range(MAX_ITER):
            critic_crew = Crew(
                agents=[critic_agent],
                tasks=[critic_task],
                process=Process.sequential,
                verbose=False,
            )
            critic_result_raw = await loop.run_in_executor(
                None,
                lambda: critic_crew.kickoff(inputs={
                    "graph_json": _json.dumps(current_graph, ensure_ascii=False)[:3000],
                    "topic": topic,
                }),
            )
            critic_text = str(critic_result_raw)

            import re as _re
            m = _re.search(r'\{[\s\S]*\}', critic_text)
            critic_data = {}
            if m:
                try:
                    critic_data = _json.loads(m.group())
                except Exception:
                    pass

            quality_score = critic_data.get("quality_score", 100)
            approved      = critic_data.get("approved", True)
            issues        = critic_data.get("issues", [])

            if approved or quality_score >= 80 or iteration == MAX_ITER - 1:
                await notify(5, AgentStatus.done,
                             f"검증 완료 — 품질 점수 {quality_score}/100 ({len(issues)}건 이슈)",
                             critic_text)
                break
            else:
                await notify(5, AgentStatus.running,
                             f"품질 점수 {quality_score} — 정제 루프 {iteration+1}회 시작...")
                # Re-run editor with critic feedback
                refinements = critic_data.get("refinements", [])
                refine_feedback = (
                    f"비판 피드백 (품질 {quality_score}/100):\n"
                    + "\n".join(f"- {iss['description']}" for iss in issues[:5]) + "\n"
                    + "수정 지시:\n"
                    + "\n".join(f"- {r['action']}: {r.get('reason','')}" for r in refinements[:5])
                )
                refined_editor_task = make_editor_task(
                    editor_agent, extraction_task, relation_task, validation_task, topic
                )
                refined_crew = Crew(
                    agents=[editor_agent],
                    tasks=[refined_editor_task],
                    process=Process.sequential,
                    verbose=False,
                )
                refined_result = await loop.run_in_executor(
                    None,
                    lambda: refined_crew.kickoff(inputs={
                        "nodes": nodes_text, "edges": edges_text,
                        "validation": validation_text + "\n\n" + refine_feedback,
                        "topic": topic,
                    }),
                )
                current_editor_text = str(refined_result)
                refined_graph = _parse_graph(current_editor_text)
                if refined_graph.get("nodes"):
                    current_graph = refined_graph

        # Attach metadata from memory
        memory_applied = []
        try:
            from memory.store import memory_store
            patterns = memory_store.get_patterns(topic)
            memory_applied = [{"pattern_id": p["id"], "original": p["original"], "corrected": p["corrected"]}
                              for p in patterns[:5]]
        except Exception:
            pass
        current_graph["schema_evolution"] = []
        current_graph["memory_applied"]   = memory_applied

        # ── Parse final graph ─────────────────────────────────────
        job.result = current_graph
        job.status = JobStatus.completed
        await broadcast({"type": "completed", "graph": current_graph})

    except BaseException as exc:
        import traceback
        err_msg = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
        print(f"[PIPELINE ERROR] {err_msg}\n{traceback.format_exc()}")
        job.status = JobStatus.failed
        job.error  = err_msg
        await broadcast({"type": "error", "message": err_msg})


def _parse_graph(text: str) -> dict:
    """Extract JSON from LLM output."""
    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    return {"nodes": [], "edges": [], "error": "Failed to parse graph JSON"}

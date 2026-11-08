"""CrewAI 오케스트레이터 데이터 흐름 테스트 (LLM 호출 없음).

각 단계에 넘어가는 inputs와 실제 렌더된 프롬프트를 가로채서,
리서치 텍스트·이전 단계 결과·Critic 피드백·정제된 그래프가 다음 단계에
실제로 도달하는지 확인한다.

실행:
    cd backend && ./venv/Scripts/python tests/test_orchestrator.py
"""
import asyncio
import json
import os
import sys

os.environ.setdefault("AUTOLOGY_SKIP_OLLAMA_AUTOSTART", "1")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crew.orchestrator as orch  # noqa: E402
from models.job import Job  # noqa: E402

DRAFT = {"nodes": [{"id": "n1", "label": "초안", "type": "Class"}], "edges": []}
REFINED = {
    "nodes": [{"id": "n1", "label": "엔진", "type": "Instance"},
              {"id": "n2", "label": "자동차", "type": "Instance"}],
    "edges": [{"id": "e1", "source": "n1", "target": "n2", "label": "has part"}],
}


def _run_pipeline(critic_scores):
    calls = []   # (role, inputs, rendered prompt)
    scores = iter(critic_scores)

    def fake_kickoff(agent, task, inputs):
        task.interpolate_inputs_and_add_conversation_history(inputs)
        calls.append((agent.role, inputs, task.prompt()))
        role = agent.role
        if role == "Extraction Agent":
            return json.dumps(DRAFT["nodes"], ensure_ascii=False)
        if role == "Relation Agent":
            return "[]"
        if role == "Validation Agent":
            return '{"issues": [], "quality_score": 70}'
        if role == "Editor Agent":
            first = inputs["current_graph"] == "(none)"
            return json.dumps(DRAFT if first else REFINED, ensure_ascii=False)
        if role == "Critic Agent":
            s = next(scores)
            return json.dumps({"quality_score": s, "approved": s >= 80,
                               "issues": [{"description": "CRITIC_ISSUE_MARKER"}],
                               "refinements": [{"action": "add_edge", "reason": "REFINE_MARKER"}]})
        raise AssertionError(role)

    import crew.tools.search as search
    orig_kick, orig_search = orch._kickoff, search.search_web
    orch._kickoff = fake_kickoff
    search.search_web = lambda topic, n=5: "RESEARCH_MARKER about " + topic
    events = []

    async def broadcast(msg):
        events.append(msg)

    try:
        job = Job(id="test", topic="자동차 {구조}", options={"max_nodes": 10})
        asyncio.run(orch._run_crewai_pipeline(job, broadcast))
    finally:
        orch._kickoff, search.search_web = orig_kick, orig_search
    return job, calls, events


def _prompts(calls, role):
    return [p for r, _, p in calls if r == role]


def test_research_and_topic_reach_extraction():
    job, calls, _ = _run_pipeline([90])
    assert job.status.value == "completed", job.error
    (prompt,) = _prompts(calls, "Extraction Agent")
    assert "RESEARCH_MARKER" in prompt and "자동차 {구조}" in prompt


def test_previous_outputs_reach_next_steps():
    _, calls, _ = _run_pipeline([90])
    assert '"초안"' in _prompts(calls, "Relation Agent")[0]
    assert '"초안"' in _prompts(calls, "Validation Agent")[0]
    assert "quality_score" in _prompts(calls, "Editor Agent")[0]


def test_refinement_feedback_and_refined_graph_flow():
    job, calls, _ = _run_pipeline([50, 90])
    editors = _prompts(calls, "Editor Agent")
    critics = _prompts(calls, "Critic Agent")
    assert len(editors) == 2 and len(critics) == 2
    # Critic feedback reaches the refining editor, with the graph being refined.
    assert "CRITIC_ISSUE_MARKER" in editors[1] and "REFINE_MARKER" in editors[1]
    assert '"초안"' in editors[1]
    # Rule-based findings (orphan node in the draft) reach critic and editor.
    assert "orphan_node" in critics[0] and "orphan_node" in editors[1]
    # The second critic reviews the refined graph, not the first draft.
    assert '"엔진"' in critics[1] and '"초안"' not in critics[1]


def test_result_is_normalized_and_validated():
    job, _, _ = _run_pipeline([50, 90])
    edges = job.result["edges"]
    assert edges[0]["label"] == "part-of" and (edges[0]["source"], edges[0]["target"]) == ("n2", "n1")
    assert "validation_report" in job.result


def _run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL  {t.__name__}: {exc!r}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return failures


if __name__ == "__main__":
    sys.exit(1 if _run_all() else 0)

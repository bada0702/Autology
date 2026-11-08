"""CrewAI Task definitions for ontology extraction pipeline."""

from crewai import Task

from vocabulary import prompt_block

CRITIC_SCHEMA = """
{
  "quality_score": 85,
  "issues": [
    {"type": "circular_dependency", "description": "A is-a B, B is-a A", "affected_ids": ["n1","n2"]},
    {"type": "missing_link",        "description": "Entity X should connect to Y", "affected_ids": ["n3"]}
  ],
  "refinements": [
    {"action": "remove_edge",   "edge_id": "e1", "reason": "Creates cycle"},
    {"action": "add_edge",      "source": "n3", "target": "n5", "label": "part-of", "reason": "Semantically required"},
    {"action": "change_type",   "node_id": "n4", "new_type": "Instance", "reason": "Concrete entity, not abstract"}
  ],
  "approved": true
}
"""

GRAPH_JSON_SCHEMA = """
{
  "nodes": [
    { "id": "n1", "label": "EntityName", "type": "Class", "x": 200, "y": 100, "properties": [], "description": "..." }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2", "label": "relationship", "style": "solid", "inferred": false }
  ]
}
"""


# Every task is executed in its own Crew, so `context=[other_task]` is not a
# reliable channel (a task that never ran, or a stale earlier run, yields the
# wrong text). All data flows through explicit {placeholders} filled by
# Crew.kickoff(inputs=...). User text such as the topic is passed the same way
# and never f-string'ed into a template, so braces in it cannot break
# interpolation.

def make_extraction_task(agent, max_nodes: int = 30) -> Task:
    return Task(
        description=(
            "Topic: {topic}\n\n"
            "Research text:\n{research_output}\n\n"
            f"From the research text above, extract up to {max_nodes} key entities of the topic. "
            "Classify each as: Class (abstract concept), Instance (concrete entity), "
            "or Literal (specific value). Include a short description for each. "
            "Write labels in {language}. Output a JSON array of node objects."
        ),
        expected_output=(
            f"A JSON array of up to {max_nodes} nodes, each with: "
            "id (string), label (entity name), type (Class/Instance/Literal), "
            "description (1 sentence), properties (array of key-value pairs)."
        ),
        agent=agent,
    )

def make_relation_task(agent) -> Task:
    return Task(
        description=(
            "Topic: {topic}\n\n"
            "Extracted entities (JSON):\n{nodes}\n\n"
            "Identify semantic relationships between these entities, using their ids.\n"
            f"{prompt_block()}\n"
            "{memory_context}\n"
            "Output a JSON array of edge objects."
        ),
        expected_output=(
            "A JSON array of edges, each with: "
            "id (string), source (node id), target (node id), label (relation id), "
            "style ('solid'), inferred (false)."
        ),
        agent=agent,
    )

def make_validation_task(agent) -> Task:
    return Task(
        description=(
            "Nodes (JSON):\n{nodes}\n\n"
            "Edges (JSON):\n{edges}\n\n"
            "Review the nodes and edges above. Check for: "
            "1) Self-loops or duplicate edges, "
            "2) Orphaned nodes (no connections), "
            "3) Type inconsistencies (e.g. Literal connected to Literal), "
            "4) Missing important relationships. "
            "Output a validation report with specific issues and fixes."
        ),
        expected_output=(
            "A JSON validation report with: "
            "issues (array of {type, description, affected_ids}), "
            "quality_score (0-100), "
            "suggested_fixes (array of {action, node_or_edge_id, detail})."
        ),
        agent=agent,
    )

def make_critic_task(agent) -> Task:
    return Task(
        description=(
            "Ontology graph for '{topic}' (JSON):\n{graph_json}\n\n"
            "Rule-based validator findings (already confirmed, must be reflected):\n{rule_issues}\n\n"
            "Perform a cross-verification of this graph. Check for: "
            "1) Circular dependencies (A→B→A), "
            "2) Type inconsistencies (Literal→Literal edges, Class used as leaf value), "
            "3) Logical contradictions (conflicting relationship directions), "
            "4) Semantic gaps (important domain concepts missing from the graph), "
            "5) Orphaned or weakly-connected subgraphs. "
            f"Output strict JSON only matching the critique schema:\n{CRITIC_SCHEMA}"
        ),
        expected_output=(
            f"A strict JSON critique report matching:\n{CRITIC_SCHEMA}\n"
            "Set approved=true if quality_score >= 80, false otherwise."
        ),
        agent=agent,
    )


def make_editor_task(agent) -> Task:
    """Builds the final graph. For refinement, {validation} carries the critic
    feedback and {current_graph} the graph being refined."""
    return Task(
        description=(
            "Topic: {topic}\n\n"
            "Nodes (JSON):\n{nodes}\n\n"
            "Edges (JSON):\n{edges}\n\n"
            "Validation report and feedback:\n{validation}\n\n"
            "Current graph to refine (empty on the first pass):\n{current_graph}\n\n"
            "Produce the final ontology graph in Autology JSON format, applying every fix "
            "from the report and feedback. Write node labels in {language}. "
            "Assign spatial coordinates: x in [100,1200], y in [100,800]. "
            "Class nodes at top (y≈150), Instance nodes in middle (y≈400), Literal at bottom (y≈650). "
            "Space nodes ~200px apart horizontally. "
            "Keep every edge label exactly as a relation id from this list (never translate it):\n"
            f"{prompt_block()}\n"
            "Return ONLY valid JSON, no markdown fences, no extra text."
        ),
        expected_output=(
            f"Valid JSON matching this schema exactly:\n{GRAPH_JSON_SCHEMA}"
        ),
        agent=agent,
    )

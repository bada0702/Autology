"""CrewAI Task definitions for ontology extraction pipeline."""

from crewai import Task

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

def make_research_task(agent, topic: str, options: dict) -> Task:
    depth = options.get("depth", "medium")
    lang  = options.get("language", "Korean")
    return Task(
        description=(
            f"Research the topic '{topic}' thoroughly. "
            f"Search depth: {depth}. Preferred language: {lang}. "
            "Collect definitions, key concepts, entities, and their relationships. "
            "Output a structured summary of your findings with clear sections."
        ),
        expected_output=(
            "A comprehensive text summary (1000-3000 words) covering: "
            "1) Core concepts and definitions, "
            "2) Key entities and their attributes, "
            "3) Relationships between entities, "
            "4) Important classifications or taxonomies."
        ),
        agent=agent,
    )

def make_extraction_task(agent, research_task: Task, max_nodes: int = 30) -> Task:
    return Task(
        description=(
            f"From the research text provided, extract up to {max_nodes} key entities. "
            "Classify each as: Class (abstract concept), Instance (concrete entity), "
            "or Literal (specific value). Include a short description for each. "
            "Output a JSON array of node objects."
        ),
        expected_output=(
            f"A JSON array of up to {max_nodes} nodes, each with: "
            "id (string), label (entity name), type (Class/Instance/Literal), "
            "description (1 sentence), properties (array of key-value pairs)."
        ),
        agent=agent,
        context=[research_task],
    )

def make_relation_task(agent, extraction_task: Task) -> Task:
    return Task(
        description=(
            "Analyze the extracted entities and identify semantic relationships between them. "
            "Use relationship types like: is-a, part-of, has-instance, has-value, "
            "related-to, located-at, participates-in, or custom domain labels. "
            "Output a JSON array of edge objects."
        ),
        expected_output=(
            "A JSON array of edges, each with: "
            "id (string), source (node id), target (node id), label (relationship type), "
            "style ('solid'), inferred (false)."
        ),
        agent=agent,
        context=[extraction_task],
    )

def make_validation_task(agent, extraction_task: Task, relation_task: Task) -> Task:
    return Task(
        description=(
            "Review the nodes and edges produced. Check for: "
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
        context=[extraction_task, relation_task],
    )

def make_editor_task(
    agent,
    extraction_task: Task,
    relation_task: Task,
    validation_task: Task,
    topic: str,
) -> Task:
    return Task(
        description=(
            f"Produce the final ontology graph for '{topic}' in Autology JSON format. "
            "Apply fixes from the validation report. "
            "Assign spatial coordinates: x in [100,1200], y in [100,800]. "
            "Class nodes at top (y≈150), Instance nodes in middle (y≈400), Literal at bottom (y≈650). "
            "Space nodes ~200px apart horizontally. "
            "Return ONLY valid JSON, no markdown fences, no extra text."
        ),
        expected_output=(
            f"Valid JSON matching this schema exactly:\n{GRAPH_JSON_SCHEMA}"
        ),
        agent=agent,
        context=[extraction_task, relation_task, validation_task],
        output_json=dict,
    )

const SEMANTIC_BASE = '/api/semantic';

async function postJSON(path, payload) {
  const res = await fetch(`${SEMANTIC_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.message || `HTTP ${res.status}`);
  }
  return data;
}

export async function getSemanticCapabilities() {
  const res = await fetch(`${SEMANTIC_BASE}/capabilities`);
  if (!res.ok) return { rdflib: false, pyshacl: false };
  return res.json();
}

export async function exportWithRDFLib(graph, format = 'turtle') {
  const data = await postJSON('/export', { graph, format });
  return data.content;
}

export async function importWithRDFLib(content, format = 'turtle') {
  const data = await postJSON('/import', { content, format });
  return data.graph;
}

// OWL 2 RL reasoning (with provenance) + rule-based validation.
// Returns { inferred: Edge[], issues: Issue[], stats }.
export async function reasonWithBackend(graph) {
  const edges = (graph.edges || []).filter(e => !e.inferred);
  return postJSON('/reason', { graph: { nodes: graph.nodes || [], edges } });
}

// ── Entity linking & knowledge base ─────────────────────────────────────────

async function requestJSON(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.message || `HTTP ${res.status}`);
  return data;
}

const jsonPost = (url, payload) => requestJSON(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

const directOnly = (graph) => ({
  nodes: graph.nodes || [],
  edges: (graph.edges || []).filter(e => !e.inferred),
});

// Attach Wikidata item ids to nodes. Returns { graph, summary }.
export const linkEntities = (graph, topic = '') =>
  jsonPost('/api/entities/link', { graph: directOnly(graph), topic });

export const getKnowledgeStats = () => requestJSON('/api/knowledge/stats');

export const ingestKnowledge = (graph, topic = '') =>
  jsonPost('/api/knowledge/ingest', { graph: directOnly(graph), topic });

export const getKnowledgeGraph = (limit = 2000) => requestJSON(`/api/knowledge/graph?limit=${limit}`);

export const getKnowledgeSubgraph = (query, hops = 1) =>
  jsonPost('/api/knowledge/subgraph', { query, hops });

export const deleteKnowledgeSource = (sourceId) =>
  requestJSON(`/api/knowledge/sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' });

export async function runSPARQL(content, query, format = 'turtle') {
  return postJSON('/sparql', { content, query, format });
}

export async function validateSHACL(data, shapes, dataFormat = 'turtle', shapesFormat = 'turtle') {
  return postJSON('/shacl', {
    data,
    shapes,
    data_format: dataFormat,
    shapes_format: shapesFormat,
  });
}

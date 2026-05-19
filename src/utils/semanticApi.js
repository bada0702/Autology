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

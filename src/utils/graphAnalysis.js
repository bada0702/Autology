// Graph analysis utilities: BFS path, centrality, N-hop subgraph, search

export function searchNodes(nodes, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return nodes.filter(n =>
    n.label.toLowerCase().includes(q) ||
    (n.description && n.description.toLowerCase().includes(q)) ||
    (n.type && n.type.toLowerCase().includes(q))
  );
}

// BFS shortest path from sourceId to targetId, returns node id array or null
export function findShortestPath(nodes, edges, sourceId, targetId) {
  if (sourceId === targetId) return [sourceId];
  const adj = {};
  for (const n of nodes) adj[n.id] = [];
  for (const e of edges) {
    if (adj[e.source]) adj[e.source].push(e.target);
    if (adj[e.target]) adj[e.target].push(e.source); // undirected search
  }

  const visited = new Set([sourceId]);
  const queue = [[sourceId]];
  while (queue.length) {
    const path = queue.shift();
    const cur = path[path.length - 1];
    for (const next of (adj[cur] || [])) {
      if (visited.has(next)) continue;
      const newPath = [...path, next];
      if (next === targetId) return newPath;
      visited.add(next);
      queue.push(newPath);
    }
  }
  return null;
}

// Degree centrality: returns { [nodeId]: degree }
export function calculateCentrality(nodes, edges) {
  const deg = {};
  for (const n of nodes) deg[n.id] = 0;
  for (const e of edges) {
    if (deg[e.source] !== undefined) deg[e.source]++;
    if (deg[e.target] !== undefined) deg[e.target]++;
  }
  return deg;
}

// N-hop subgraph: returns { nodeIds: Set, edgeIds: Set }
export function getNHopSubgraph(nodes, edges, centerId, hops) {
  const nodeIds = new Set([centerId]);
  const frontier = new Set([centerId]);

  for (let h = 0; h < hops; h++) {
    const next = new Set();
    for (const e of edges) {
      if (frontier.has(e.source) && !nodeIds.has(e.target)) {
        nodeIds.add(e.target);
        next.add(e.target);
      }
      if (frontier.has(e.target) && !nodeIds.has(e.source)) {
        nodeIds.add(e.source);
        next.add(e.source);
      }
    }
    frontier.clear();
    for (const id of next) frontier.add(id);
  }

  const edgeIds = new Set(
    edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target)).map(e => e.id)
  );
  return { nodeIds, edgeIds };
}

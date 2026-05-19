// Merge multiple partial graphs (from chunked LLM extraction) into one
// Deduplicates nodes by label+type, edges by source+target+label

export function mergeGraphs(graphList) {
  const nodeMap = new Map(); // key: label.toLowerCase()+'|'+type → node
  const edgeSet = new Set(); // key: srcLabel|tgtLabel|edgeLabel

  for (const { nodes = [], edges = [] } of graphList) {
    // Merge nodes
    for (const n of nodes) {
      const key = `${n.label.toLowerCase()}|${n.type}`;
      if (!nodeMap.has(key)) {
        nodeMap.set(key, { ...n, id: `node_${Date.now()}_${Math.random().toString(36).slice(2)}` });
      } else {
        // Merge descriptions
        const existing = nodeMap.get(key);
        if (n.description && !existing.description) {
          nodeMap.set(key, { ...existing, description: n.description });
        }
        // Merge properties
        if (n.properties?.length) {
          const merged = [...(existing.properties || [])];
          for (const p of n.properties) {
            if (!merged.some(m => m.key === p.key)) merged.push(p);
          }
          nodeMap.set(key, { ...nodeMap.get(key), properties: merged });
        }
      }
    }

    // Collect edges (resolved after all nodes merged)
    for (const e of edges) {
      const srcNode = nodes.find(n => n.id === e.source || n.label === e.source);
      const tgtNode = nodes.find(n => n.id === e.target || n.label === e.target);
      if (!srcNode || !tgtNode) continue;
      const edgeKey = `${srcNode.label.toLowerCase()}|${tgtNode.label.toLowerCase()}|${(e.label || '').toLowerCase()}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
      }
    }
  }

  const nodes = [...nodeMap.values()].map((n, i) => ({
    ...n,
    x: n.x ?? (i % 5) * 220 + 80,
    y: n.y ?? Math.floor(i / 5) * 160 + 80,
    properties: n.properties || [],
    description: n.description || '',
  }));

  // Rebuild edges with new node ids
  const labelToId = new Map(nodes.map(n => [`${n.label.toLowerCase()}|${n.type}`, n.id]));
  const edges = [];
  const seenEdges = new Set();

  for (const { nodes: chunkNodes = [], edges: chunkEdges = [] } of graphList) {
    for (const e of chunkEdges) {
      const srcNode = chunkNodes.find(n => n.id === e.source || n.label === e.source);
      const tgtNode = chunkNodes.find(n => n.id === e.target || n.label === e.target);
      if (!srcNode || !tgtNode) continue;

      const srcKey = `${srcNode.label.toLowerCase()}|${srcNode.type}`;
      const tgtKey = `${tgtNode.label.toLowerCase()}|${tgtNode.type}`;
      const srcId  = labelToId.get(srcKey);
      const tgtId  = labelToId.get(tgtKey);
      if (!srcId || !tgtId || srcId === tgtId) continue;

      const edgeKey = `${srcId}|${tgtId}|${(e.label || '').toLowerCase()}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);

      edges.push({
        id: `edge_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        source: srcId,
        target: tgtId,
        label: e.label || '',
        style: 'solid',
        inferred: false,
      });
    }
  }

  return { nodes, edges };
}

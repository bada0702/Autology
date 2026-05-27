// Auto-layout algorithms for the ontology graph.
// All functions return { [nodeId]: { x, y } } position maps.

const NODE_W = 160;
const NODE_H = 56;

// ── Hierarchical (top→down by type) ───────────────────────────────────────────
export function hierarchicalLayout(nodes, edges) {
  if (nodes.length === 0) return {};

  const H_GAP      = 220;  // horizontal spacing between nodes
  const ROW_V_GAP  = 100;  // vertical spacing between rows within same tier
  const TIER_GAP   = 260;  // vertical spacing between different tiers
  const MAX_PER_ROW = 8;   // wrap to new row after this many nodes

  const degree = {};
  for (const n of nodes) degree[n.id] = 0;
  for (const e of edges) {
    if (degree[e.source] !== undefined) degree[e.source]++;
    if (degree[e.target] !== undefined) degree[e.target]++;
  }

  const tiers = { Class: [], Instance: [], Literal: [] };
  for (const n of nodes) {
    const key = tiers[n.type] !== undefined ? n.type : 'Instance';
    tiers[key].push(n);
  }
  for (const arr of Object.values(tiers)) {
    arr.sort((a, b) => degree[b.id] - degree[a.id]);
  }

  const positions = {};
  let currentY = 80;

  for (const [, group] of Object.entries(tiers)) {
    if (group.length === 0) continue;

    // Split into rows of MAX_PER_ROW
    const rows = [];
    for (let i = 0; i < group.length; i += MAX_PER_ROW) {
      rows.push(group.slice(i, i + MAX_PER_ROW));
    }

    rows.forEach((row, rowIdx) => {
      const totalW = (row.length - 1) * H_GAP;
      const startX = Math.max(60, 600 - totalW / 2);
      row.forEach((n, i) => {
        positions[n.id] = {
          x: startX + i * H_GAP,
          y: currentY + rowIdx * (NODE_H + ROW_V_GAP),
        };
      });
    });

    currentY += rows.length * (NODE_H + ROW_V_GAP) + TIER_GAP;
  }

  return positions;
}

// ── Radial (most-connected center, BFS rings) ─────────────────────────────────
export function radialLayout(nodes, edges) {
  if (nodes.length === 0) return {};

  const MIN_SPACING = NODE_W + 80; // minimum arc-length gap between nodes
  const BASE_R      = 240;
  const CX = 620, CY = 440;

  const degree = {};
  const adj    = {};
  for (const n of nodes) { degree[n.id] = 0; adj[n.id] = new Set(); }
  for (const e of edges) {
    const s = e.source, t = e.target;
    if (degree[s] !== undefined) { degree[s]++; adj[s].add(t); }
    if (degree[t] !== undefined) { degree[t]++; adj[t].add(s); }
  }

  const root = nodes.reduce((a, b) => degree[a.id] >= degree[b.id] ? a : b);

  const level = {};
  const queue = [root.id];
  level[root.id] = 0;
  while (queue.length) {
    const id = queue.shift();
    for (const nid of (adj[id] || [])) {
      if (level[nid] === undefined) {
        level[nid] = level[id] + 1;
        queue.push(nid);
      }
    }
  }
  const maxLv = Math.max(...Object.values(level), 0);
  for (const n of nodes) {
    if (level[n.id] === undefined) level[n.id] = maxLv + 1;
  }

  const byLevel = {};
  for (const n of nodes) {
    const lv = level[n.id];
    (byLevel[lv] = byLevel[lv] || []).push(n.id);
  }

  const positions = {};
  for (const [lv, ids] of Object.entries(byLevel)) {
    const l = Number(lv);
    if (l === 0) {
      positions[ids[0]] = { x: CX - NODE_W / 2, y: CY - NODE_H / 2 };
      continue;
    }
    // Radius grows with level AND scales up if ring has many nodes
    const minR = (ids.length * MIN_SPACING) / (2 * Math.PI);
    const r = Math.max(l * BASE_R, minR);
    ids.forEach((id, i) => {
      const angle = (2 * Math.PI * i) / ids.length - Math.PI / 2;
      positions[id] = {
        x: CX + r * Math.cos(angle) - NODE_W / 2,
        y: CY + r * Math.sin(angle) - NODE_H / 2,
      };
    });
  }

  return positions;
}

// ── Cluster-Grid (connected components → compact grids, no overlap guaranteed) ─
export function forceLayout(nodes, edges) {
  if (nodes.length === 0) return {};
  if (nodes.length === 1) return { [nodes[0].id]: { x: 500, y: 350 } };

  const COL_GAP = NODE_W + 60;   // horizontal cell size
  const ROW_GAP = NODE_H + 50;   // vertical cell size
  const COMP_PAD_X = 100;        // gap between components horizontally
  const COMP_PAD_Y = 80;         // gap between components vertically
  const MAX_ROW_W  = Math.max(1400, Math.sqrt(nodes.length) * 320);

  // ── 1. Degree map ──────────────────────────────────────────────────────────
  const degree = {};
  for (const n of nodes) degree[n.id] = 0;
  for (const e of edges) {
    if (degree[e.source] !== undefined) degree[e.source]++;
    if (degree[e.target] !== undefined) degree[e.target]++;
  }

  // ── 2. Connected components (Union-Find) ───────────────────────────────────
  const parent = {};
  for (const n of nodes) parent[n.id] = n.id;
  function find(x) {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  for (const e of edges) {
    if (parent[e.source] !== undefined && parent[e.target] !== undefined) {
      parent[find(e.source)] = find(e.target);
    }
  }

  const compMap = {};
  for (const n of nodes) {
    const root = find(n.id);
    (compMap[root] = compMap[root] || []).push(n);
  }
  // Sort components largest-first; within each, most-connected nodes first
  const comps = Object.values(compMap)
    .sort((a, b) => b.length - a.length)
    .map(c => c.sort((a, b) => degree[b.id] - degree[a.id]));

  // ── 3. BFS order within each component for better edge locality ────────────
  function bfsOrder(comp) {
    const adj = {};
    for (const n of comp) adj[n.id] = [];
    for (const e of edges) {
      if (adj[e.source] !== undefined && adj[e.target] !== undefined) {
        adj[e.source].push(e.target);
        adj[e.target].push(e.source);
      }
    }
    const visited = new Set();
    const result = [];
    // Start from highest-degree node
    const queue = [comp[0].id];
    visited.add(comp[0].id);
    while (queue.length) {
      const id = queue.shift();
      result.push(id);
      for (const nid of (adj[id] || []).sort((a, b) => degree[b] - degree[a])) {
        if (!visited.has(nid)) { visited.add(nid); queue.push(nid); }
      }
    }
    // Add any disconnected remainder
    for (const n of comp) {
      if (!visited.has(n.id)) result.push(n.id);
    }
    return result;
  }

  // ── 4. Place components row by row ────────────────────────────────────────
  const positions = {};
  let curX = 80, curY = 80, rowH = 0;

  for (const comp of comps) {
    const order  = bfsOrder(comp);
    const cols   = Math.max(1, Math.ceil(Math.sqrt(order.length)));
    const compW  = cols * COL_GAP - (COL_GAP - NODE_W);
    const compH  = Math.ceil(order.length / cols) * ROW_GAP - (ROW_GAP - NODE_H);

    // Wrap to new row if this component doesn't fit
    if (curX > 80 && curX + compW > MAX_ROW_W) {
      curY += rowH + COMP_PAD_Y;
      curX  = 80;
      rowH  = 0;
    }

    order.forEach((id, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      positions[id] = {
        x: curX + col * COL_GAP,
        y: curY + row * ROW_GAP,
      };
    });

    rowH  = Math.max(rowH, compH);
    curX += compW + COMP_PAD_X;
  }

  return positions;
}

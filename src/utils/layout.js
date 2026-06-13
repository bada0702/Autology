// Auto-layout algorithms for the ontology graph.
// All functions return { [nodeId]: { x, y } } position maps.

const NODE_W = 180;
const NODE_H = 60;

function computeDegree(nodes, edges) {
  const degree = {};
  for (const n of nodes) degree[n.id] = 0;
  for (const e of edges) {
    if (degree[e.source] !== undefined) degree[e.source]++;
    if (degree[e.target] !== undefined) degree[e.target]++;
  }
  return degree;
}

// ── Hierarchical (grid per type tier) ────────────────────────────────────────
export function hierarchicalLayout(nodes, edges) {
  if (nodes.length === 0) return {};

  const H_GAP_X  = NODE_W + 40;   // horizontal spacing
  const H_GAP_Y  = NODE_H + 40;   // row spacing within a tier
  const TIER_GAP = 160;            // vertical gap between tiers

  const degree = computeDegree(nodes, edges);

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

  for (const type of ['Class', 'Literal', 'Instance']) {
    const group = tiers[type];
    if (group.length === 0) continue;

    // Number of columns: roughly square grid, capped at 12 for readability
    const COLS = Math.min(group.length, Math.max(1, Math.round(Math.sqrt(group.length * 1.6))));
    const totalW = (COLS - 1) * H_GAP_X;
    const startX = Math.max(60, 900 - totalW / 2);

    group.forEach((n, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      positions[n.id] = {
        x: startX + col * H_GAP_X,
        y: currentY + row * H_GAP_Y,
      };
    });

    const rows = Math.ceil(group.length / COLS);
    currentY += rows * H_GAP_Y + TIER_GAP;
  }

  return positions;
}

// ── Radial (radius scaled to avoid crowding) ──────────────────────────────────
export function radialLayout(nodes, edges) {
  if (nodes.length === 0) return {};

  const MIN_ARC = NODE_W + 20; // minimum arc length per node
  const BASE_R  = 260;
  const CX = 900, CY = 600;

  const degree = computeDegree(nodes, edges);
  const adj = {};
  for (const n of nodes) adj[n.id] = new Set();
  for (const e of edges) {
    if (adj[e.source]) adj[e.source].add(e.target);
    if (adj[e.target]) adj[e.target].add(e.source);
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
    // Scale radius so nodes don't overlap: circumference >= count * MIN_ARC
    const minR = (ids.length * MIN_ARC) / (2 * Math.PI);
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

// ── Force-directed (canvas scaled to node count) ──────────────────────────────
export function forceLayout(nodes, edges, iterations = 200) {
  if (nodes.length === 0) return {};
  if (nodes.length === 1) {
    return { [nodes[0].id]: { x: 500, y: 350 } };
  }

  // Scale canvas to number of nodes so they have room
  const area = Math.max(nodes.length * 30000, 1100 * 780);
  const W = Math.round(Math.sqrt(area * 1.6));
  const H = Math.round(Math.sqrt(area / 1.6));
  const k = Math.sqrt((W * H) / nodes.length) * 1.4;

  const pos = {};
  const cols = Math.ceil(Math.sqrt(nodes.length));
  nodes.forEach((n, i) => {
    pos[n.id] = {
      x: (i % cols) * (W / cols) + 80 + Math.random() * 10,
      y: Math.floor(i / cols) * (H / Math.ceil(nodes.length / cols)) + 80 + Math.random() * 10,
    };
  });

  for (let iter = 0; iter < iterations; iter++) {
    const t = iter / iterations;
    const temp = k * Math.pow(1 - t, 1.5) * 0.8;
    const disp = {};
    for (const n of nodes) disp[n.id] = { x: 0, y: 0 };

    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i].id, b = nodes[j].id;
        const dx = pos[a].x - pos[b].x;
        const dy = pos[a].y - pos[b].y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const f = (k * k) / dist;
        const ux = (dx / dist) * f;
        const uy = (dy / dist) * f;
        disp[a].x += ux; disp[a].y += uy;
        disp[b].x -= ux; disp[b].y -= uy;
      }
    }

    // Attraction
    for (const e of edges) {
      if (!pos[e.source] || !pos[e.target]) continue;
      const dx = pos[e.target].x - pos[e.source].x;
      const dy = pos[e.target].y - pos[e.source].y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = (dist * dist) / k;
      const ux = (dx / dist) * f;
      const uy = (dy / dist) * f;
      disp[e.source].x += ux; disp[e.source].y += uy;
      disp[e.target].x -= ux; disp[e.target].y -= uy;
    }

    // Apply
    for (const n of nodes) {
      const d = disp[n.id];
      const dlen = Math.sqrt(d.x * d.x + d.y * d.y) || 1;
      const factor = Math.min(dlen, temp) / dlen;
      pos[n.id].x = Math.max(40, Math.min(W - NODE_W, pos[n.id].x + d.x * factor));
      pos[n.id].y = Math.max(40, Math.min(H - NODE_H, pos[n.id].y + d.y * factor));
    }
  }

  return pos;
}

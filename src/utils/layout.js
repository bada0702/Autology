// Auto-layout algorithms for the ontology graph.
// All functions return { [nodeId]: { x, y } } position maps.

const NODE_W = 160;
const NODE_H = 56;

// ── Hierarchical (top→down by type) ───────────────────────────────────────────
export function hierarchicalLayout(nodes, edges) {
  if (nodes.length === 0) return {};

  const TIER_Y   = { Class: 80, Instance: 320, Literal: 560 };
  const H_GAP    = 200;
  const CANVAS_CX = 600;

  // Sort each tier by degree (most connected first) for readable layout
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
  for (const [type, group] of Object.entries(tiers)) {
    if (group.length === 0) continue;
    const totalW = (group.length - 1) * H_GAP;
    const startX = Math.max(60, CANVAS_CX - totalW / 2);
    group.forEach((n, i) => {
      positions[n.id] = { x: startX + i * H_GAP, y: TIER_Y[type] };
    });
  }

  return positions;
}

// ── Radial (most-connected center, BFS rings) ─────────────────────────────────
export function radialLayout(nodes, edges) {
  if (nodes.length === 0) return {};

  const BASE_R = 200;
  const CX = 580, CY = 380;

  const degree = {};
  const adj    = {};
  for (const n of nodes) { degree[n.id] = 0; adj[n.id] = new Set(); }
  for (const e of edges) {
    const s = e.source, t = e.target;
    if (degree[s] !== undefined) { degree[s]++; adj[s].add(t); }
    if (degree[t] !== undefined) { degree[t]++; adj[t].add(s); }
  }

  // Most-connected node as root
  const root = nodes.reduce((a, b) => degree[a.id] >= degree[b.id] ? a : b);

  // BFS to assign levels
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
  // Unreachable nodes get outer ring
  for (const n of nodes) {
    if (level[n.id] === undefined) level[n.id] = maxLv + 1;
  }

  // Group by level
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
    const r = l * BASE_R;
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

// ── Force-directed (Fruchterman-Reingold, simplified) ─────────────────────────
export function forceLayout(nodes, edges, iterations = 120) {
  if (nodes.length === 0) return {};
  if (nodes.length === 1) {
    return { [nodes[0].id]: { x: 500, y: 350 } };
  }

  const W = 1100, H = 780;
  const k = Math.sqrt((W * H) / nodes.length) * 1.2;

  // Seed positions in a grid
  const pos = {};
  const cols = Math.ceil(Math.sqrt(nodes.length));
  nodes.forEach((n, i) => {
    pos[n.id] = {
      x: (i % cols) * (W / cols) + 80 + Math.random() * 20,
      y: Math.floor(i / cols) * (H / Math.ceil(nodes.length / cols)) + 80 + Math.random() * 20,
    };
  });

  for (let iter = 0; iter < iterations; iter++) {
    const temp = k * (1 - iter / iterations) * 0.5;
    const disp = {};
    for (const n of nodes) disp[n.id] = { x: 0, y: 0 };

    // Repulsion between all pairs
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i].id, b = nodes[j].id;
        const dx = pos[a].x - pos[b].x;
        const dy = pos[a].y - pos[b].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (k * k) / dist;
        const ux = (dx / dist) * f;
        const uy = (dy / dist) * f;
        disp[a].x += ux; disp[a].y += uy;
        disp[b].x -= ux; disp[b].y -= uy;
      }
    }

    // Attraction along edges
    for (const e of edges) {
      if (!pos[e.source] || !pos[e.target]) continue;
      const dx = pos[e.target].x - pos[e.source].x;
      const dy = pos[e.target].y - pos[e.source].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (dist * dist) / k;
      const ux = (dx / dist) * f;
      const uy = (dy / dist) * f;
      disp[e.source].x += ux; disp[e.source].y += uy;
      disp[e.target].x -= ux; disp[e.target].y -= uy;
    }

    // Apply with temperature clamp + boundary
    for (const n of nodes) {
      const d = disp[n.id];
      const dlen = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01;
      const factor = Math.min(dlen, temp) / dlen;
      pos[n.id].x = Math.max(40, Math.min(W - NODE_W, pos[n.id].x + d.x * factor));
      pos[n.id].y = Math.max(40, Math.min(H - NODE_H, pos[n.id].y + d.y * factor));
    }
  }

  return pos;
}

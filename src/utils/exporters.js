import { NODE_W, NODE_H } from '../constants/nodeTypes';

// ── Helpers ────────────────────────────────────────────────────────────────────

function escXML(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function borderPoint(node, tx, ty) {
  const cx = node.x + NODE_W / 2, cy = node.y + NODE_H / 2;
  const dx = tx - cx, dy = ty - cy;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return { x: cx, y: cy };
  const s = Math.min((NODE_W / 2 + 2) / Math.abs(dx), (NODE_H / 2 + 2) / Math.abs(dy));
  return { x: cx + dx * s, y: cy + dy * s };
}

function mermaidSafeId(id) {
  return 'n' + id.replace(/[^a-zA-Z0-9]/g, '_');
}

function mermaidLabel(str) {
  return String(str).replace(/"/g, "'").replace(/\[/g, '(').replace(/\]/g, ')');
}

function download(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Mermaid ────────────────────────────────────────────────────────────────────

export function exportToMermaid(nodes, edges) {
  if (nodes.length === 0) return 'graph TD\n  %% 노드가 없습니다';

  const lines = ['graph TD'];

  for (const n of nodes) {
    const id  = mermaidSafeId(n.id);
    const lbl = mermaidLabel(n.label);
    // Class = rect, Instance = round rect, Literal = stadium
    const shape =
      n.type === 'Class'    ? `["${lbl}"]`   :
      n.type === 'Instance' ? `("${lbl}")`   :
                              `(["${lbl}"])`;
    lines.push(`  ${id}${shape}`);
  }

  lines.push('');

  for (const e of edges) {
    const src = mermaidSafeId(e.source);
    const tgt = mermaidSafeId(e.target);
    const lbl = e.label ? `|"${mermaidLabel(e.label)}"|` : '';
    const arr = e.inferred ? '-.->': '-->';
    lines.push(`  ${src} ${arr}${lbl} ${tgt}`);
  }

  lines.push('');
  lines.push('  classDef classNode    fill:#1e3a8a,stroke:#818cf8,color:#eef2ff');
  lines.push('  classDef instanceNode fill:#064e3b,stroke:#34d399,color:#ecfdf5');
  lines.push('  classDef literalNode  fill:#451a03,stroke:#fbbf24,color:#fefce8');

  const groups = { classNode: [], instanceNode: [], literalNode: [] };
  for (const n of nodes) {
    const id = mermaidSafeId(n.id);
    if (n.type === 'Class')    groups.classNode.push(id);
    if (n.type === 'Instance') groups.instanceNode.push(id);
    if (n.type === 'Literal')  groups.literalNode.push(id);
  }
  for (const [cls, ids] of Object.entries(groups)) {
    if (ids.length) lines.push(`  class ${ids.join(',')} ${cls}`);
  }

  return lines.join('\n');
}

// ── Markdown ───────────────────────────────────────────────────────────────────

export function exportToMarkdown(nodes, edges) {
  const now     = new Date().toLocaleDateString('ko-KR');
  const classes = nodes.filter(n => n.type === 'Class');
  const insts   = nodes.filter(n => n.type === 'Instance');
  const lits    = nodes.filter(n => n.type === 'Literal');
  const direct  = edges.filter(e => !e.inferred);
  const inferred = edges.filter(e => e.inferred);
  const byId    = Object.fromEntries(nodes.map(n => [n.id, n]));

  const lines = [
    '# 온톨로지 보고서', '',
    `> **생성일:** ${now} &nbsp;|&nbsp; **도구:** Autology`, '',
    '---', '',
    '## 개요', '',
    '| 항목 | 수 |',
    '|------|---:|',
    `| 전체 노드 | **${nodes.length}** |`,
    `| Class (추상 개념) | ${classes.length} |`,
    `| Instance (실제 개체) | ${insts.length} |`,
    `| Literal (값) | ${lits.length} |`,
    `| 직접 관계 | ${direct.length} |`,
    `| 추론 관계 | ${inferred.length} |`,
    '', '---', '',
  ];

  const renderSection = (n) => {
    lines.push(`### ${n.label}`, '');
    if (n.description) lines.push(n.description, '');
    if (n.properties?.length) {
      lines.push('**프로퍼티:**');
      for (const p of n.properties) lines.push(`- \`${p.key}\`: ${p.value}`);
      lines.push('');
    }
    const outs = direct.filter(e => e.source === n.id);
    const ins  = direct.filter(e => e.target === n.id);
    if (outs.length || ins.length) {
      lines.push('**관계:**');
      for (const e of outs) {
        const t = byId[e.target];
        if (t) lines.push(`- → \`${e.label || 'related'}\` → **${t.label}**`);
      }
      for (const e of ins) {
        const s = byId[e.source];
        if (s) lines.push(`- ← \`${e.label || 'related'}\` ← **${s.label}**`);
      }
    }
    lines.push('');
  };

  if (classes.length) { lines.push('## 클래스 (Class)', ''); classes.forEach(renderSection); }
  if (insts.length)   { lines.push('## 인스턴스 (Instance)', ''); insts.forEach(renderSection); }
  if (lits.length)    { lines.push('## 리터럴 (Literal)', ''); lits.forEach(renderSection); }

  if (direct.length) {
    lines.push('---', '', '## 관계 목록', '',
      '| 출발 | 관계 | 도착 |',
      '|------|------|------|',
    );
    for (const e of direct) {
      const s = byId[e.source], t = byId[e.target];
      if (s && t) lines.push(`| ${s.label} | \`${e.label || '—'}\` | ${t.label} |`);
    }
    lines.push('');
  }

  if (inferred.length) {
    lines.push('---', '', '## 추론 관계 (Rule 엔진)', '',
      '| 출발 | 추론 관계 | 도착 |',
      '|------|-----------|------|',
    );
    for (const e of inferred) {
      const s = byId[e.source], t = byId[e.target];
      if (s && t) lines.push(`| ${s.label} | ⚡ \`${e.label || '—'}\` | ${t.label} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Cypher (Neo4j) ─────────────────────────────────────────────────────────────

export function exportToCypher(nodes, edges) {
  const escStr  = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const relName = s => (s || 'RELATED_TO').replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase() || 'RELATED_TO';

  const lines = [
    '// Autology → Neo4j Cypher',
    '// 사용법: Neo4j Browser 또는 cypher-shell에 붙여넣기',
    '',
    '// ── 노드 생성 ─────────────────────────────────────────',
  ];

  for (const n of nodes) {
    const props = [
      `id: '${escStr(n.id)}'`,
      `label: '${escStr(n.label)}'`,
      n.description ? `description: '${escStr(n.description)}'` : null,
      ...(n.properties || []).map(p =>
        `${p.key.replace(/\s+/g, '_')}: '${escStr(p.value)}'`
      ),
    ].filter(Boolean).join(', ');
    lines.push(`MERGE (:${n.type} {${props}})`);
  }

  const direct = edges.filter(e => !e.inferred);
  if (direct.length) {
    lines.push('', '// ── 관계 생성 ─────────────────────────────────────────');
    for (const e of direct) {
      lines.push(
        `MATCH (a {id: '${escStr(e.source)}'}), (b {id: '${escStr(e.target)}'})`,
        `MERGE (a)-[:${relName(e.label)}]->(b)`,
      );
    }
  }

  return lines.join('\n');
}

// ── SVG (synthetic, no external libs) ─────────────────────────────────────────

export function exportToSVG(nodes, edges) {
  if (nodes.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#09090f"/><text x="120" y="44" text-anchor="middle" font-family="system-ui" font-size="13" fill="rgba(255,255,255,0.4)">노드가 없습니다</text></svg>';
  }

  const PAD  = 60;
  const minX = Math.min(...nodes.map(n => n.x)) - PAD;
  const minY = Math.min(...nodes.map(n => n.y)) - PAD;
  const maxX = Math.max(...nodes.map(n => n.x + NODE_W)) + PAD;
  const maxY = Math.max(...nodes.map(n => n.y + NODE_H)) + PAD;
  const vw   = maxX - minX, vh = maxY - minY;

  const STYLE = {
    Class:    { bg: '#1e2d6e', border: '#818cf8', text: '#eef2ff' },
    Instance: { bg: '#0d3d2e', border: '#34d399', text: '#ecfdf5' },
    Literal:  { bg: '#3b2006', border: '#fbbf24', text: '#fefce8' },
  };

  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));

  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${minX} ${minY} ${vw} ${vh}">`,
    `<defs>`,
    `  <style>text { font-family: Inter, system-ui, sans-serif; }</style>`,
    `  <marker id="ar"  markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="rgba(255,255,255,0.4)"/></marker>`,
    `  <marker id="ari" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="rgba(167,139,250,0.7)"/></marker>`,
    `</defs>`,
    `<rect x="${minX}" y="${minY}" width="${vw}" height="${vh}" fill="#09090f"/>`,
  ];

  // Edges
  for (const e of edges) {
    const s = nodeMap[e.source], t = nodeMap[e.target];
    if (!s || !t) continue;
    const tCx = t.x + NODE_W / 2, tCy = t.y + NODE_H / 2;
    const sCx = s.x + NODE_W / 2, sCy = s.y + NODE_H / 2;
    const p1  = borderPoint(s, tCx, tCy);
    const p2  = borderPoint(t, sCx, sCy);
    const mx  = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const cx1 = p1.x + (mx - p1.x) * 0.5, cy1 = p1.y + (my - p1.y) * 0.05;
    const cx2 = mx  + (p2.x - mx)  * 0.5, cy2 = my  + (p2.y - my)  * 0.05;
    const col  = e.inferred ? 'rgba(167,139,250,0.65)' : 'rgba(255,255,255,0.3)';
    const dash = e.inferred ? 'stroke-dasharray="7 4"' : '';
    const mid  = e.inferred ? 'ari' : 'ar';
    out.push(`<path d="M ${p1.x} ${p1.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p2.x} ${p2.y}" fill="none" stroke="${col}" stroke-width="1.8" ${dash} marker-end="url(#${mid})"/>`);
    if (e.label) out.push(`<text x="${mx}" y="${my - 7}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.45)">${escXML(e.label)}</text>`);
    if (e.inferred) out.push(`<text x="${mx + 14}" y="${my + 4}" font-size="11" fill="#a78bfa">⚡</text>`);
  }

  // Nodes
  for (const n of nodes) {
    const c = STYLE[n.type] || STYLE.Class;
    out.push(
      `<rect x="${n.x}" y="${n.y}" width="${NODE_W}" height="${NODE_H}" rx="10" fill="${c.bg}" stroke="${c.border}" stroke-width="1.5"/>`,
      `<text x="${n.x + NODE_W / 2}" y="${n.y + 24}" text-anchor="middle" font-size="13" font-weight="600" fill="${c.text}">${escXML(n.label)}</text>`,
      `<text x="${n.x + NODE_W / 2}" y="${n.y + 40}" text-anchor="middle" font-size="10" fill="${c.border}">${n.type}</text>`,
    );
  }

  out.push('</svg>');
  return out.join('\n');
}

// ── PNG (SVG → canvas → data URL) ─────────────────────────────────────────────

export async function exportToPNG(nodes, edges) {
  const svgStr = exportToSVG(nodes, edges);
  const blob   = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url    = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const SCALE  = 2; // retina
      const canvas = document.createElement('canvas');
      canvas.width  = (img.naturalWidth  || 800) * SCALE;
      canvas.height = (img.naturalHeight || 600) * SCALE;
      const ctx = canvas.getContext('2d');
      ctx.scale(SCALE, SCALE);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지 렌더링 실패')); };
    img.src = url;
  });
}

// ── Convenience wrappers (trigger browser download) ────────────────────────────

const datestamp = () => new Date().toISOString().slice(0, 10);

export function saveMermaid(nodes, edges)  { download(exportToMermaid(nodes, edges),  `autology_${datestamp()}.mmd`,    'text/plain'); }
export function saveMarkdown(nodes, edges) { download(exportToMarkdown(nodes, edges), `autology_${datestamp()}.md`,     'text/markdown'); }
export function saveCypher(nodes, edges)   { download(exportToCypher(nodes, edges),   `autology_${datestamp()}.cypher`, 'text/plain'); }
export function saveSVG(nodes, edges)      { download(exportToSVG(nodes, edges),      `autology_${datestamp()}.svg`,    'image/svg+xml'); }

export async function savePNG(nodes, edges) {
  const dataUrl = await exportToPNG(nodes, edges);
  const a = document.createElement('a');
  a.href = dataUrl; a.download = `autology_${datestamp()}.png`; a.click();
}

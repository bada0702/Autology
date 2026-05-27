import * as XLSX from 'xlsx';

export async function parseFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'txt' || ext === 'md') {
    return await readAsText(file);
  }

  if (ext === 'csv') {
    const text = await readAsText(file);
    return csvToReadable(text);
  }

  if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') {
    return await parseExcel(file);
  }

  throw new Error(`지원하지 않는 파일 형식: .${ext}`);
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('파일 읽기 실패'));
    reader.readAsText(file, 'UTF-8');
  });
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('파일 읽기 실패'));
    reader.readAsArrayBuffer(file);
  });
}

async function parseExcel(file) {
  const buffer = await readAsArrayBuffer(file);
  const workbook = XLSX.read(buffer, { type: 'array' });
  const parts = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (rows.length === 0) continue;

    parts.push(`[시트: ${sheetName}]`);
    for (const row of rows) {
      const line = row.map(c => String(c).trim()).filter(Boolean).join('\t');
      if (line) parts.push(line);
    }
  }

  return parts.join('\n');
}

function csvToReadable(text) {
  return text
    .split('\n')
    .map(line => line.split(',').map(c => c.trim().replace(/^"|"$/g, '')).join('\t'))
    .join('\n');
}

// ── CSV → Knowledge Graph ─────────────────────────────────

export function isCSVLike(text) {
  if (!text) return false;
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 3) return false;
  const sep = _detectSep(lines[0]);
  if (!sep) return false;
  const cols = lines[0].split(sep).length;
  return cols >= 3 && lines.slice(1, 5).every(l => l.split(sep).length >= cols - 1);
}

function _detectSep(line) {
  if (line.split(',').length >= 3) return ',';
  if (line.split('\t').length >= 3) return '\t';
  return null;
}

export function parseCSVToGraph(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return { nodes: [], edges: [] };

  const sep = _detectSep(lines[0]) || ',';
  const split = line => line.split(sep).map(v => v.trim().replace(/^"|"$/g, ''));
  const header = split(lines[0]);

  // Determine label column (name-like)
  const LABEL_CANDIDATES = ['함명', '이름', 'name', 'label', '명칭', '제품명', '품명'];
  const labelCol = LABEL_CANDIDATES.find(c => header.includes(c)) || header[2] || header[0];

  // Determine category (class) columns — at most first 2 categorical columns
  const CAT_CANDIDATES = ['함종', '함급', '종류', '분류', 'type', 'class', 'category', '카테고리'];
  const catCols = CAT_CANDIDATES.filter(c => header.includes(c)).slice(0, 2);

  const rows = lines.slice(1).map(line => {
    const vals = split(line);
    const obj = {};
    header.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });

  const nodes = [];
  const edges = [];
  const classNodeMap = {}; // "col:val" → nodeId

  const X_GAP = 220;
  const Y_GAP = 160;
  const CLASS_ROWS = catCols.length;

  // Class nodes: group by category columns, stacked in rows
  catCols.forEach((col, ci) => {
    const uniq = [...new Set(rows.map(r => r[col]).filter(Boolean))];
    uniq.forEach((val, vi) => {
      const key = `${col}::${val}`;
      if (classNodeMap[key]) return;
      const nid = `cls_${ci}_${vi}`;
      classNodeMap[key] = nid;
      nodes.push({
        id: nid,
        label: val,
        type: 'Class',
        x: 180 + vi * X_GAP,
        y: 120 + ci * 150,
        properties: [{ key: '분류기준', value: col }],
        description: `${col}: ${val}`,
      });
    });

    // 함종 → 함급 hierarchy edges (catCols[0] is-a catCols[1])
    if (ci === 1) {
      const col0 = catCols[0];
      rows.forEach(r => {
        const parentKey = `${col0}::${r[col0]}`;
        const childKey  = `${col}::${r[col]}`;
        const src = classNodeMap[childKey];
        const tgt = classNodeMap[parentKey];
        if (src && tgt) {
          const eid = `ehier_${src}_${tgt}`;
          if (!edges.find(e => e.id === eid)) {
            edges.push({ id: eid, source: src, target: tgt, label: 'is-a', style: 'solid', inferred: false });
          }
        }
      });
    }
  });

  // Instance nodes (one per row)
  const propCols = header.filter(h => h !== labelCol && !catCols.includes(h));
  const instancesPerRow = 8;

  rows.forEach((row, idx) => {
    const label = row[labelCol] || `항목_${idx + 1}`;
    const nid = `inst_${idx}`;
    const col = idx % instancesPerRow;
    const rowNum = Math.floor(idx / instancesPerRow);

    nodes.push({
      id: nid,
      label,
      type: 'Instance',
      x: 180 + col * X_GAP,
      y: 120 + CLASS_ROWS * 150 + 80 + rowNum * Y_GAP,
      properties: propCols.map(h => ({ key: h, value: row[h] })).filter(p => p.value),
      description: catCols.map(c => `${c}: ${row[c]}`).filter(p => p.split(': ')[1]).join(' / '),
    });

    // Edge to most-specific category (last catCol)
    const lastCat = catCols[catCols.length - 1];
    if (lastCat) {
      const key = `${lastCat}::${row[lastCat]}`;
      const targetId = classNodeMap[key];
      if (targetId) {
        edges.push({
          id: `emember_${nid}`,
          source: nid,
          target: targetId,
          label: '소속',
          style: 'solid',
          inferred: false,
        });
      }
    }
  });

  return { nodes, edges };
}

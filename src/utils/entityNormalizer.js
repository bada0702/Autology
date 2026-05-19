// Entity normalization utilities for ontology graphs.

// ── Label normalization ────────────────────────────────────────────────────────

export function normalizeLabel(label, type) {
  let s = String(label).trim().replace(/\s+/g, ' ');
  if (type === 'Class') {
    // Capitalize each word
    s = s.replace(/\b\w/g, c => c.toUpperCase());
  } else if (type === 'Instance') {
    // First letter capital, rest as-is
    s = s.charAt(0).toUpperCase() + s.slice(1);
  } else if (type === 'Literal') {
    // Remove surrounding quotes if any
    s = s.replace(/^["']|["']$/g, '');
  }
  return s;
}

// ── String similarity ──────────────────────────────────────────────────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// Similarity score 0..1 (higher = more similar)
function similarity(a, b) {
  const la = a.toLowerCase().trim();
  const lb = b.toLowerCase().trim();
  if (la === lb) return 1;
  const dist = levenshtein(la, lb);
  const maxLen = Math.max(la.length, lb.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

// ── Merge suggestion detection ─────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.75; // minimum similarity to suggest merge
const MIN_LABEL_LEN = 2;           // ignore very short labels

export function detectSimilarNodes(nodes) {
  const suggestions = [];
  const direct = nodes.filter(n => n.label.length >= MIN_LABEL_LEN);

  for (let i = 0; i < direct.length; i++) {
    for (let j = i + 1; j < direct.length; j++) {
      const a = direct[i], b = direct[j];

      const score = similarity(a.label, b.label);
      if (score < SIMILARITY_THRESHOLD) continue;

      const la = a.label.toLowerCase().trim();
      const lb = b.label.toLowerCase().trim();

      let reason;
      if (la === lb && a.type !== b.type) {
        reason = `동일 레이블, 타입 다름 (${a.type} ↔ ${b.type})`;
      } else if (la === lb) {
        reason = '동일 레이블 (대소문자 차이)';
      } else if (la.startsWith(lb) || lb.startsWith(la)) {
        reason = '접두사 일치';
      } else if (la.includes(lb) || lb.includes(la)) {
        reason = '포함 관계';
      } else {
        reason = `유사 레이블 (유사도 ${Math.round(score * 100)}%)`;
      }

      suggestions.push({
        id: `sug_${a.id}_${b.id}`,
        nodeA: a,
        nodeB: b,
        score,
        reason,
      });
    }
  }

  // Sort by score descending
  return suggestions.sort((a, b) => b.score - a.score);
}

// ── Label normalization batch ──────────────────────────────────────────────────

export function buildNormalizedLabels(nodes) {
  return Object.fromEntries(
    nodes.map(n => [n.id, normalizeLabel(n.label, n.type)])
  );
}

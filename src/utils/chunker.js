// Text chunking for large document analysis
// Uses word-based approximation: 1 word ≈ 1.3 tokens

const CHUNK_WORDS  = 1150; // ≈ 1500 tokens
const OVERLAP_WORDS = 155; // ≈ 200 tokens

export function chunkText(text) {
  if (!text) return [];
  const words = text.trim().split(/\s+/);
  if (words.length <= CHUNK_WORDS) return [text.trim()];

  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + CHUNK_WORDS, words.length);
    chunks.push(words.slice(start, end).join(' '));
    start += CHUNK_WORDS - OVERLAP_WORDS;
  }
  return chunks;
}

export function estimateChunks(text) {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).length;
  if (words <= CHUNK_WORDS) return 1;
  return Math.ceil((words - OVERLAP_WORDS) / (CHUNK_WORDS - OVERLAP_WORDS));
}

// Row-based chunking: splits multi-line text by N rows (keeps header on every chunk)
const ROWS_PER_CHUNK = 25;

export function chunkByRows(text, rowsPerChunk = ROWS_PER_CHUNK) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length <= rowsPerChunk + 1) return [text.trim()];
  const header = lines[0];
  const dataLines = lines.slice(1);
  const chunks = [];
  for (let i = 0; i < dataLines.length; i += rowsPerChunk) {
    const batch = dataLines.slice(i, i + rowsPerChunk);
    chunks.push([header, ...batch].join('\n'));
  }
  return chunks;
}

export function estimateRowChunks(text) {
  const lines = text.trim().split('\n').filter(l => l.trim()).length;
  return Math.max(1, Math.ceil((lines - 1) / ROWS_PER_CHUNK));
}

export const NODE_TYPES = {
  CLASS: 'Class',
  INSTANCE: 'Instance',
  LITERAL: 'Literal',
};

export const NODE_COLORS = {
  Class:    '#60a5fa',
  Instance: '#34d399',
  Literal:  '#fbbf24',
  // Dynamic schema evolution types
  SubClass:   '#c084fc',
  Event:      '#fb923c',
  Role:       '#22d3ee',
  Process:    '#f472b6',
  Abstract:   '#a3e635',
};

export const NODE_BG = {
  Class:    'rgba(96,165,250,0.12)',
  Instance: 'rgba(52,211,153,0.12)',
  Literal:  'rgba(251,191,36,0.12)',
  // Dynamic schema evolution types
  SubClass:   'rgba(192,132,252,0.12)',
  Event:      'rgba(251,146,60,0.12)',
  Role:       'rgba(34,211,238,0.12)',
  Process:    'rgba(244,114,182,0.12)',
  Abstract:   'rgba(163,230,53,0.12)',
};

// Deterministic fallback color for unknown dynamic types
const DYNAMIC_PALETTE = [
  ['#c084fc','rgba(192,132,252,0.12)'],
  ['#fb923c','rgba(251,146,60,0.12)'],
  ['#22d3ee','rgba(34,211,238,0.12)'],
  ['#f472b6','rgba(244,114,182,0.12)'],
  ['#a3e635','rgba(163,230,53,0.12)'],
];

function typeHash(type) {
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return h;
}

export function getNodeColor(type) {
  if (NODE_COLORS[type]) return NODE_COLORS[type];
  return DYNAMIC_PALETTE[typeHash(type) % DYNAMIC_PALETTE.length][0];
}

export function getNodeBg(type) {
  if (NODE_BG[type]) return NODE_BG[type];
  return DYNAMIC_PALETTE[typeHash(type) % DYNAMIC_PALETTE.length][1];
}

// Approximate node dimensions for edge intersection math
export const NODE_W = 148;
export const NODE_H = 52;

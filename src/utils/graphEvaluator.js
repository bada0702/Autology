// Knowledge Graph Quality Evaluator
// 구조 점수, 온톨로지 규칙 점수, 완성도, RAG/검색 성능 추정 지표 산출

import { calculateCentrality, findShortestPath } from './graphAnalysis';

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function clamp(v, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }

function detectCycles(nodes, edges) {
  const adj = {};
  for (const n of nodes) adj[n.id] = [];
  for (const e of edges) {
    if (!e.inferred && adj[e.source]) adj[e.source].push(e.target);
  }
  const visited = new Set(), recStack = new Set();
  let cycleCount = 0;
  function dfs(id) {
    visited.add(id);
    recStack.add(id);
    for (const nb of (adj[id] || [])) {
      if (!visited.has(nb)) { if (dfs(nb)) return true; }
      else if (recStack.has(nb)) { cycleCount++; return true; }
    }
    recStack.delete(id);
    return false;
  }
  for (const n of nodes) if (!visited.has(n.id)) dfs(n.id);
  return cycleCount;
}

function connectedComponents(nodes, edges) {
  const adj = {};
  for (const n of nodes) adj[n.id] = new Set();
  for (const e of edges) {
    if (adj[e.source]) adj[e.source].add(e.target);
    if (adj[e.target]) adj[e.target].add(e.source);
  }
  const visited = new Set();
  let count = 0;
  for (const n of nodes) {
    if (visited.has(n.id)) continue;
    count++;
    const stack = [n.id];
    while (stack.length) {
      const cur = stack.pop();
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const nb of (adj[cur] || [])) if (!visited.has(nb)) stack.push(nb);
    }
  }
  return count;
}

function avgShortestPath(nodes, edges) {
  // Sample up to 20 random pairs (expensive for large graphs)
  if (nodes.length < 2) return 0;
  const sample = nodes.slice(0, Math.min(10, nodes.length));
  let total = 0, count = 0;
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const path = findShortestPath(nodes, edges, sample[i].id, sample[j].id);
      if (path) { total += path.length - 1; count++; }
    }
  }
  return count ? total / count : 0;
}

// ── 1. 구조 평가 ─────────────────────────────────────────────────────────────

export function evalStructure(nodes, edges) {
  const n = nodes.length, e = edges.filter(x => !x.inferred).length;
  if (n === 0) return { score: 0, details: {}, breakdown: [] };

  // 고립 노드
  const isolated = nodes.filter(nd =>
    !edges.some(ex => ex.source === nd.id || ex.target === nd.id)
  ).length;
  const isolatedRatio = isolated / n;

  // 밀도 (방향 그래프 기준)
  const maxEdges = n * (n - 1);
  const density = maxEdges > 0 ? e / maxEdges : 0;
  // 이상적 범위 0.05 ~ 0.35
  const densityScore = density === 0 ? 0
    : density < 0.05 ? clamp(density / 0.05 * 60)
    : density < 0.35 ? clamp(60 + (density - 0.05) / 0.30 * 40)
    : clamp(100 - (density - 0.35) / 0.65 * 50);

  // 컴포넌트
  const components = connectedComponents(nodes, edges);
  const componentScore = n === 0 ? 0 : clamp((1 - (components - 1) / n) * 100);

  // 사이클
  const cycles = detectCycles(nodes, edges);
  const cycleScore = clamp(100 - cycles * 15);

  // 중심성 편중 (Gini 계수 근사)
  const deg = Object.values(calculateCentrality(nodes, edges));
  const maxDeg = Math.max(...deg, 1);
  const hubScore = clamp(100 - (maxDeg / (e * 2 || 1)) * 100 * 0.5);

  // Class/Instance 비율
  const classes = nodes.filter(x => x.type === 'Class').length;
  const instances = nodes.filter(x => x.type === 'Instance').length;
  const ratio = classes > 0 ? instances / classes : 0;
  // 이상적 1:2 ~ 1:6
  const ratioScore = instances === 0 ? 30
    : ratio < 1 ? clamp(ratio * 70)
    : ratio <= 6 ? clamp(70 + (ratio - 1) / 5 * 30)
    : clamp(100 - (ratio - 6) * 5);

  const score = clamp(
    densityScore * 0.25 +
    componentScore * 0.25 +
    cycleScore * 0.20 +
    hubScore * 0.15 +
    ratioScore * 0.15
  );

  return {
    score: Math.round(score),
    details: { n, e, isolated, density, components, cycles, classes, instances },
    breakdown: [
      { label: '밀도', value: Math.round(densityScore), desc: `${(density * 100).toFixed(1)}%` },
      { label: '연결성', value: Math.round(componentScore), desc: `${components}개 컴포넌트` },
      { label: '순환 없음', value: Math.round(cycleScore), desc: `${cycles}개 순환` },
      { label: '허브 균형', value: Math.round(hubScore), desc: `최대차수 ${maxDeg}` },
      { label: 'Class:Instance', value: Math.round(ratioScore), desc: `${classes}:${instances}` },
    ],
  };
}

// ── 2. 온톨로지 규칙 평가 ─────────────────────────────────────────────────────

export function evalOntology(nodes, edges) {
  const n = nodes.length;
  if (n === 0) return { score: 0, violations: [], breakdown: [] };

  const byId = Object.fromEntries(nodes.map(nd => [nd.id, nd]));
  const violations = [];

  // (a) Literal 노드가 source인 엣지
  const litAsSrc = edges.filter(e => {
    const s = byId[e.source];
    return s && s.type === 'Literal' && !e.inferred;
  }).length;
  if (litAsSrc > 0) violations.push({ rule: 'Literal→관계 금지', count: litAsSrc, severity: 'warn' });

  // (b) Instance가 Instance를 rdf:type으로 가리킴
  const badType = edges.filter(e => {
    const s = byId[e.source], t = byId[e.target];
    return e.label === 'rdf:type' && s?.type === 'Instance' && t?.type === 'Instance';
  }).length;
  if (badType > 0) violations.push({ rule: 'Instance rdf:type Instance', count: badType, severity: 'error' });

  // (c) 빈 레이블
  const emptyLabel = nodes.filter(nd => !nd.label || nd.label.trim().length < 2).length;
  if (emptyLabel > 0) violations.push({ rule: '빈/짧은 레이블', count: emptyLabel, severity: 'warn' });

  // (d) 고아 Literal (연결된 엣지 없음)
  const orphanLit = nodes.filter(nd =>
    nd.type === 'Literal' &&
    !edges.some(e => e.source === nd.id || e.target === nd.id)
  ).length;
  if (orphanLit > 0) violations.push({ rule: '고아 Literal 노드', count: orphanLit, severity: 'warn' });

  // (e) 중복 레이블 (대소문자 무시)
  const seen = {}, dupCount = {};
  for (const nd of nodes) {
    const k = nd.label.trim().toLowerCase();
    if (seen[k]) dupCount[k] = (dupCount[k] || 1) + 1;
    else seen[k] = true;
  }
  const dups = Object.keys(dupCount).length;
  if (dups > 0) violations.push({ rule: '중복 레이블', count: dups, severity: 'warn' });

  // (f) self-loop
  const selfLoop = edges.filter(e => e.source === e.target).length;
  if (selfLoop > 0) violations.push({ rule: '자기 참조(self-loop)', count: selfLoop, severity: 'error' });

  // 점수 계산: 위반 건수 기반 감점
  const errorPenalty = violations.filter(v => v.severity === 'error').reduce((s, v) => s + v.count * 12, 0);
  const warnPenalty  = violations.filter(v => v.severity === 'warn').reduce((s, v) => s + v.count * 5, 0);
  const score = clamp(100 - errorPenalty - warnPenalty);

  return {
    score: Math.round(score),
    violations,
    breakdown: [
      { label: 'Literal 규칙', value: clamp(100 - litAsSrc * 15), desc: `${litAsSrc}건 위반` },
      { label: '타입 일관성', value: clamp(100 - badType * 20), desc: `${badType}건 위반` },
      { label: '레이블 품질', value: clamp(100 - (emptyLabel + dups) * 8), desc: `${emptyLabel + dups}건` },
      { label: 'Literal 연결', value: clamp(100 - orphanLit * 10), desc: `${orphanLit}개 고아` },
      { label: '자기참조', value: clamp(100 - selfLoop * 25), desc: `${selfLoop}건` },
    ],
  };
}

// ── 3. 완성도 평가 ────────────────────────────────────────────────────────────

export function evalCompleteness(nodes, edges) {
  const n = nodes.length;
  if (n === 0) return { score: 0, breakdown: [] };

  // 설명 채움률
  const withDesc = nodes.filter(nd => nd.description && nd.description.trim().length > 10).length;
  const descScore = clamp((withDesc / n) * 100);

  // 프로퍼티 채움률
  const withProps = nodes.filter(nd => (nd.properties || []).length > 0).length;
  const propScore = clamp((withProps / n) * 100);

  // 엣지 레이블 채움률
  const e = edges.filter(x => !x.inferred);
  const labeledEdges = e.filter(ex => ex.label && ex.label.trim().length > 0).length;
  const edgeLabelScore = e.length === 0 ? 100 : clamp((labeledEdges / e.length) * 100);

  // 최소 규모 (노드 5개, 엣지 3개 이상을 '완성됨'으로 봄)
  const sizeScore = clamp(Math.min(n / 5, 1) * 50 + Math.min(e.length / 3, 1) * 50);

  const score = clamp(
    descScore * 0.30 +
    propScore * 0.15 +
    edgeLabelScore * 0.30 +
    sizeScore * 0.25
  );

  return {
    score: Math.round(score),
    breakdown: [
      { label: '노드 설명', value: Math.round(descScore), desc: `${withDesc}/${n}개` },
      { label: '프로퍼티', value: Math.round(propScore), desc: `${withProps}/${n}개` },
      { label: '엣지 레이블', value: Math.round(edgeLabelScore), desc: `${labeledEdges}/${e.length}개` },
      { label: '그래프 규모', value: Math.round(sizeScore), desc: `노드 ${n} / 엣지 ${e.length}` },
    ],
  };
}

// ── 4. RAG 인지 성능 평가 ─────────────────────────────────────────────────────
// LLM이 이 그래프를 컨텍스트로 받았을 때 얼마나 잘 이해할 수 있는가

export function evalRAGCognition(nodes, edges) {
  const n = nodes.length;
  if (n === 0) return { score: 0, breakdown: [], tokenEstimate: 0 };

  // 컨텍스트 크기 추정 (토큰)
  let charCount = 0;
  for (const nd of nodes) {
    charCount += (nd.label || '').length + (nd.description || '').length;
    for (const p of (nd.properties || [])) charCount += (p.key || '').length + (p.value || '').length;
  }
  for (const e of edges.filter(x => !x.inferred)) {
    charCount += (e.label || '').length + 10;
  }
  const tokenEstimate = Math.round(charCount / 3.5); // 한국어 대략 3.5char/token

  // 컨텍스트 크기 점수 (4k token 이하 = 이상적, 16k 초과 = 부담)
  const ctxScore = tokenEstimate < 1000 ? clamp(tokenEstimate / 1000 * 80)
    : tokenEstimate < 4000 ? 95
    : tokenEstimate < 8000 ? clamp(95 - (tokenEstimate - 4000) / 4000 * 25)
    : clamp(70 - (tokenEstimate - 8000) / 8000 * 40);

  // 레이블 명확성 — 평균 레이블 길이 (2~15자 이상적)
  const avgLabelLen = n === 0 ? 0 : nodes.reduce((s, nd) => s + (nd.label || '').length, 0) / n;
  const labelClarityScore = avgLabelLen < 2 ? 20
    : avgLabelLen <= 15 ? 100
    : clamp(100 - (avgLabelLen - 15) * 3);

  // 설명 품질 (설명 있는 노드 비율 × 평균 설명 길이 점수)
  const withDesc = nodes.filter(nd => nd.description && nd.description.length > 20);
  const descQuality = withDesc.length === 0 ? 0
    : clamp((withDesc.length / n) * 100 * Math.min(1, withDesc.reduce((s, nd) => s + nd.description.length, 0) / withDesc.length / 100));

  // 관계 명확성 — 레이블 없는 엣지 비율
  const dirEdges = edges.filter(x => !x.inferred);
  const unlabeled = dirEdges.filter(e => !e.label || !e.label.trim()).length;
  const relClarityScore = dirEdges.length === 0 ? 100 : clamp(100 - (unlabeled / dirEdges.length) * 100);

  // 구조 복잡도 (LLM이 파악하기 쉬운 depth-of-hierarchy 선호)
  const deg = calculateCentrality(nodes, edges);
  const maxDeg = Math.max(...Object.values(deg), 1);
  const complexityScore = clamp(100 - Math.max(0, maxDeg - 8) * 5);

  const score = clamp(
    ctxScore * 0.20 +
    labelClarityScore * 0.20 +
    descQuality * 0.25 +
    relClarityScore * 0.20 +
    complexityScore * 0.15
  );

  return {
    score: Math.round(score),
    tokenEstimate,
    breakdown: [
      { label: '컨텍스트 크기', value: Math.round(ctxScore), desc: `~${tokenEstimate.toLocaleString()} tokens` },
      { label: '레이블 명확성', value: Math.round(labelClarityScore), desc: `평균 ${avgLabelLen.toFixed(1)}자` },
      { label: '설명 품질', value: Math.round(descQuality), desc: `${withDesc.length}/${n}개 유효` },
      { label: '관계 명확성', value: Math.round(relClarityScore), desc: `미표기 ${unlabeled}개` },
      { label: '복잡도 적합', value: Math.round(complexityScore), desc: `최대차수 ${maxDeg}` },
    ],
  };
}

// ── 5. 검색 속도 성능 평가 ────────────────────────────────────────────────────
// 그래프 탐색/조회가 얼마나 효율적인지 구조 기반 추정

export function evalSearchPerformance(nodes, edges) {
  const n = nodes.length, e = edges.filter(x => !x.inferred).length;
  if (n === 0) return { score: 0, breakdown: [], avgPathLen: 0 };

  // 평균 최단 경로 (샘플) — 짧을수록 검색 빠름
  const avgPath = avgShortestPath(nodes, edges);
  // 이상적: 2~4홉, 6홉 이상이면 느림
  const pathScore = avgPath === 0 ? 50
    : avgPath <= 2 ? 90
    : avgPath <= 4 ? clamp(90 - (avgPath - 2) * 10)
    : clamp(70 - (avgPath - 4) * 15);

  // 엣지/노드 비율 (인덱스 밀도)
  const edgeRatio = n > 0 ? e / n : 0;
  // 이상적 1.5~4배 (너무 적으면 탐색 어려움, 너무 많으면 노이즈)
  const edgeRatioScore = edgeRatio < 0.5 ? clamp(edgeRatio / 0.5 * 50)
    : edgeRatio < 4 ? clamp(50 + (edgeRatio - 0.5) / 3.5 * 50)
    : clamp(100 - (edgeRatio - 4) * 8);

  // 연결 컴포넌트 수 — 1개가 이상적
  const components = connectedComponents(nodes, edges);
  const componentScore = clamp(100 - (components - 1) * 20);

  // 허브 노드 활용도 (검색 앵커로 쓸 수 있는 고차수 노드 비율)
  const deg = calculateCentrality(nodes, edges);
  const hubNodes = Object.values(deg).filter(d => d >= 3).length;
  const hubUtilScore = n === 0 ? 0 : clamp((hubNodes / n) * 200); // 50% 이상이면 100점

  // 인덱스 적합성: 레이블 있는 엣지 비율 (검색 필터로 활용)
  const labeled = edges.filter(x => !x.inferred && x.label && x.label.trim()).length;
  const indexScore = e === 0 ? 100 : clamp((labeled / e) * 100);

  const score = clamp(
    pathScore * 0.30 +
    edgeRatioScore * 0.20 +
    componentScore * 0.20 +
    hubUtilScore * 0.15 +
    indexScore * 0.15
  );

  return {
    score: Math.round(score),
    avgPathLen: Math.round(avgPath * 10) / 10,
    breakdown: [
      { label: '평균 경로 길이', value: Math.round(pathScore), desc: avgPath ? `${avgPath.toFixed(1)}홉` : '단절됨' },
      { label: '엣지 밀도', value: Math.round(edgeRatioScore), desc: `비율 ${edgeRatio.toFixed(2)}` },
      { label: '단일 컴포넌트', value: Math.round(componentScore), desc: `${components}개` },
      { label: '허브 활용도', value: Math.round(hubUtilScore), desc: `${hubNodes}개 허브` },
      { label: '엣지 인덱스', value: Math.round(indexScore), desc: `${labeled}/${e}개 표기` },
    ],
  };
}

// ── 종합 평가 ─────────────────────────────────────────────────────────────────

export function evaluateGraph(nodes, edges) {
  const structure    = evalStructure(nodes, edges);
  const ontology     = evalOntology(nodes, edges);
  const completeness = evalCompleteness(nodes, edges);
  const ragCognition = evalRAGCognition(nodes, edges);
  const searchPerf   = evalSearchPerformance(nodes, edges);

  const overall = Math.round(
    structure.score    * 0.25 +
    ontology.score     * 0.20 +
    completeness.score * 0.20 +
    ragCognition.score * 0.20 +
    searchPerf.score   * 0.15
  );

  return { overall, structure, ontology, completeness, ragCognition, searchPerf };
}

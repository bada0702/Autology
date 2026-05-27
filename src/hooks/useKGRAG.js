import { useContext, useRef, useCallback } from 'react';
import GraphContext from '../context/GraphContext';
import LLMContext, { makeOllamaFetch } from '../context/LLMContext';

// ── 1. 쿼리에서 앵커 노드 찾기 ──────────────────────────────────────────────
// 쿼리 텍스트에서 레이블이 언급된 노드를 점수 순으로 반환

function findAnchorNodes(nodes, query) {
  const q = query.toLowerCase();
  const scored = nodes.map(n => {
    const label = n.label.toLowerCase();
    let score = 0;
    if (q.includes(label))           score += 10;   // 완전 일치 포함
    else if (label.includes(q))      score += 6;    // 레이블이 쿼리를 포함
    else {
      // 단어 단위 부분 매칭
      const words = label.split(/[\s_\-]+/);
      for (const w of words) {
        if (w.length >= 2 && q.includes(w)) score += 3;
      }
      // 쿼리 단어가 레이블에 포함
      const qWords = q.split(/[\s_\-]+/);
      for (const w of qWords) {
        if (w.length >= 2 && label.includes(w)) score += 2;
      }
    }
    // description 보조 매칭
    if (n.description && n.description.toLowerCase().includes(q)) score += 1;
    return { node: n, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.node);
}

// ── 2. 양방향 N-hop 서브그래프 추출 ────────────────────────────────────────
// 방향 무관하게 연결된 노드/엣지를 hops 거리 내에서 수집

function extractBidirectionalSubgraph(nodes, edges, anchorIds, hops = 2) {
  const nodeSet = new Set(anchorIds);
  const frontier = new Set(anchorIds);

  for (let h = 0; h < hops; h++) {
    const next = new Set();
    for (const e of edges) {
      // 순방향: source가 frontier → target 추가
      if (frontier.has(e.source) && !nodeSet.has(e.target)) {
        nodeSet.add(e.target);
        next.add(e.target);
      }
      // 역방향: target이 frontier → source 추가 (핵심 수정)
      if (frontier.has(e.target) && !nodeSet.has(e.source)) {
        nodeSet.add(e.source);
        next.add(e.source);
      }
    }
    frontier.clear();
    for (const id of next) frontier.add(id);
    if (frontier.size === 0) break;
  }

  const subNodes = nodes.filter(n => nodeSet.has(n.id));
  const subEdges = edges.filter(e =>
    !e.inferred && nodeSet.has(e.source) && nodeSet.has(e.target)
  );

  return { subNodes, subEdges };
}

// ── 3. 서브그래프를 LLM 친화적 텍스트로 직렬화 ────────────────────────────
// 단순 목록이 아니라 노드 중심으로 "인접 관계"를 함께 서술

function serializeSubgraph(subNodes, subEdges, anchorIds) {
  const byId = Object.fromEntries(subNodes.map(n => [n.id, n]));

  const lines = [];

  for (const n of subNodes) {
    const isAnchor = anchorIds.includes(n.id);
    const header = `[${n.type}] ${n.label}${isAnchor ? ' ★' : ''}`;
    lines.push(header);

    if (n.description) lines.push(`  설명: ${n.description}`);
    if (n.properties?.length) {
      for (const p of n.properties) lines.push(`  ${p.key}: ${p.value}`);
    }

    // 나가는 엣지 (순방향)
    const outEdges = subEdges.filter(e => e.source === n.id);
    for (const e of outEdges) {
      const t = byId[e.target];
      if (t) lines.push(`  → [${e.label || 'related'}] → ${t.label} [${t.type}]`);
    }

    // 들어오는 엣지 (역방향) — 핵심: 상위→하위 관계를 하위 노드 시점에서도 표현
    const inEdges = subEdges.filter(e => e.target === n.id);
    for (const e of inEdges) {
      const s = byId[e.source];
      if (s) lines.push(`  ← [${e.label || 'related'}] ← ${s.label} [${s.type}]`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ── 4. 폴백: 그래프 전체가 작을 때 전체 직렬화 ────────────────────────────

function serializeFullGraph(nodes, edges) {
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const lines = [];
  for (const n of nodes) {
    lines.push(`[${n.type}] ${n.label}${n.description ? ' — ' + n.description : ''}`);
    const outEdges = edges.filter(e => !e.inferred && e.source === n.id);
    const inEdges  = edges.filter(e => !e.inferred && e.target === n.id);
    for (const e of outEdges) {
      const t = byId[e.target];
      if (t) lines.push(`  → [${e.label || 'related'}] → ${t.label}`);
    }
    for (const e of inEdges) {
      const s = byId[e.source];
      if (s) lines.push(`  ← [${e.label || 'related'}] ← ${s.label}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── 시스템 프롬프트 ────────────────────────────────────────────────────────

const SYSTEM_TEMPLATE = (context, mode, anchorLabels) => `당신은 온톨로지 지식 그래프 기반 AI 어시스턴트 'Autology AI'입니다.
반드시 한국어로 답변하세요.

검색 모드: ${mode}
${anchorLabels.length ? `쿼리 핵심 노드: ${anchorLabels.join(', ')}` : ''}

아래 지식 그래프 컨텍스트를 최우선으로 참고하여 답변하세요.
"→"는 순방향 관계, "←"는 역방향 관계(해당 노드가 대상)를 의미합니다.
★ 표시는 쿼리와 직접 관련된 핵심 노드입니다.

[지식 그래프 컨텍스트]
${context}

그래프에 없는 정보는 일반 지식으로 보완하되, 그래프 정보와 구분하여 답변하세요.`;

// ── 메인 훅 ───────────────────────────────────────────────────────────────

export function useKGRAG() {
  const { state: graphState } = useContext(GraphContext);
  const { state: llmState, dispatch: llmDispatch } = useContext(LLMContext);
  const abortCtrlRef = useRef(null);

  const cancel = useCallback(() => {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }
    llmDispatch({ type: 'FINISH_GENERATION' });
  }, [llmDispatch]);

  const askKG = async (query, history = [], onChunk) => {
    if (!llmState.ollamaOnline) {
      llmDispatch({ type: 'SET_ERROR', payload: 'Ollama 서버가 오프라인입니다.' });
      return;
    }

    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;

    llmDispatch({ type: 'START_GENERATION' });

    const { nodes, edges } = graphState;

    // ── 컨텍스트 구성 ──────────────────────────────────────────
    let context, mode, anchorLabels = [];
    let evidenceNodeIds = [], evidenceEdgeIds = [];

    if (nodes.length === 0) {
      context = '(그래프가 비어 있습니다)';
      mode = '없음';
    } else if (nodes.length <= 15) {
      // 소형 그래프: 전체 직렬화 (방향 포함)
      context = serializeFullGraph(nodes, edges);
      mode = '전체 그래프';
      evidenceNodeIds = nodes.map(n => n.id);
      evidenceEdgeIds = edges.filter(e => !e.inferred).map(e => e.id);
    } else {
      // 대형 그래프: 쿼리 기반 서브그래프 추출
      const anchors = findAnchorNodes(nodes, query);

      if (anchors.length === 0) {
        // 앵커 미발견 → 중심성 높은 노드 3개를 앵커로 사용
        const deg = {};
        for (const n of nodes) deg[n.id] = 0;
        for (const e of edges) {
          if (deg[e.source] !== undefined) deg[e.source]++;
          if (deg[e.target] !== undefined) deg[e.target]++;
        }
        const topNodes = [...nodes]
          .sort((a, b) => (deg[b.id] || 0) - (deg[a.id] || 0))
          .slice(0, 3);
        const { subNodes, subEdges } = extractBidirectionalSubgraph(
          nodes, edges, topNodes.map(n => n.id), 2
        );
        context = serializeSubgraph(subNodes, subEdges, topNodes.map(n => n.id));
        mode = '허브 중심 서브그래프 (앵커 미발견)';
        anchorLabels = topNodes.map(n => n.label);
        evidenceNodeIds = subNodes.map(n => n.id);
        evidenceEdgeIds = subEdges.map(e => e.id);
      } else {
        // 상위 3개 앵커로 2-hop 서브그래프 추출
        const topAnchors = anchors.slice(0, 3);
        anchorLabels = topAnchors.map(n => n.label);
        const { subNodes, subEdges } = extractBidirectionalSubgraph(
          nodes, edges, topAnchors.map(n => n.id), 2
        );

        // 서브그래프가 너무 작으면 hop 확장
        const { subNodes: subNodes3, subEdges: subEdges3 } =
          subNodes.length < 4
            ? extractBidirectionalSubgraph(nodes, edges, topAnchors.map(n => n.id), 3)
            : { subNodes, subEdges };

        context = serializeSubgraph(subNodes3, subEdges3, topAnchors.map(n => n.id));
        mode = `쿼리 기반 서브그래프 (${subNodes3.length}/${nodes.length} 노드, 양방향 2-hop)`;
        evidenceNodeIds = subNodes3.map(n => n.id);
        evidenceEdgeIds = subEdges3.map(e => e.id);
      }
    }

    const systemPrompt = SYSTEM_TEMPLATE(context, mode, anchorLabels);

    // ── LLM 호출 ──────────────────────────────────────────────
    try {
      const res = await makeOllamaFetch(llmState.ollamaUrl, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: llmState.model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'user', content: query },
          ],
          stream: true,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';

      while (true) {
        if (ctrl.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split('\n')) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            if (json.message?.content) {
              fullContent += json.message.content;
              if (onChunk) onChunk(json.message.content);
            }
          } catch {}
        }
      }

      abortCtrlRef.current = null;
      llmDispatch({ type: 'FINISH_GENERATION' });
      if (ctrl.signal.aborted) return null;
      return {
        content: fullContent,
        meta: { mode, anchorLabels },
        evidencePath: { nodeIds: evidenceNodeIds, edgeIds: evidenceEdgeIds },
      };
    } catch (err) {
      abortCtrlRef.current = null;
      if (err.name === 'AbortError') {
        llmDispatch({ type: 'FINISH_GENERATION' });
        return null;
      }
      llmDispatch({ type: 'SET_ERROR', payload: err.message });
      return null;
    }
  };

  return { askKG, cancel, isGenerating: llmState.isGenerating };
}

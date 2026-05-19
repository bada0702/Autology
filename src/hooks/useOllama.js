import { useContext } from 'react';
import GraphContext from '../context/GraphContext';
import LLMContext, { makeOllamaFetch } from '../context/LLMContext';

const GRAPH_SYSTEM = `당신은 온톨로지 그래프 전문가입니다. 사용자의 텍스트에서 엔티티와 관계를 추출하여 JSON 지식 그래프로 반환하세요.

설명 없이 유효한 JSON만 반환하세요:
{
  "nodes": [
    { "id": "n1", "label": "엔티티명", "type": "Class", "x": 200, "y": 100, "properties": [], "description": "" }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2", "label": "관계", "style": "solid", "inferred": false }
  ]
}

노드 타입 규칙:
- Class: 추상 개념 (사람, 도시, 조직, 이벤트)
- Instance: 구체적 개체 (홍길동, 서울, ACME Corp)
- Literal: 구체적 값 ("1990-01-01", "25", "한국")

노드 배치: x: 100-1200, y: 100-800 범위, ~200px 간격. Class는 상단, Instance는 중간, Literal은 하단.`;

const DESC_SYSTEM = `당신은 온톨로지 전문가입니다. 노드의 타입, 레이블, 관계를 바탕으로 해당 노드가 지식 그래프에서 어떤 역할을 하는지 2-3문장으로 설명하세요. 반드시 한국어로 답변하세요.`;

export function useOllama() {
  const { state: llmState, dispatch: llmDispatch } = useContext(LLMContext);
  const { dispatch: graphDispatch } = useContext(GraphContext);

  const ollamaFetch = (path, options = {}) =>
    makeOllamaFetch(llmState.ollamaUrl, path, options);

  const generateGraph = async (prompt) => {
    if (!llmState.ollamaOnline) {
      llmDispatch({ type: 'SET_ERROR', payload: `Ollama 서버에 연결할 수 없습니다. (${llmState.ollamaUrl})` });
      return false;
    }
    llmDispatch({ type: 'START_GENERATION' });
    try {
      const res = await ollamaFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: llmState.model,
          messages: [
            { role: 'system', content: GRAPH_SYSTEM },
            { role: 'user', content: prompt }
          ],
          stream: false
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const content = data.message?.content || '';

      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('JSON을 파싱할 수 없습니다.');
      const graph = JSON.parse(match[0]);
      graphDispatch({ type: 'LOAD_GRAPH', payload: graph });
      llmDispatch({ type: 'FINISH_GENERATION' });
      return true;
    } catch (err) {
      llmDispatch({ type: 'SET_ERROR', payload: err.message });
      return false;
    }
  };

  const generateDescription = async (node, relatedEdges, nodes) => {
    if (!llmState.ollamaOnline) return;
    llmDispatch({ type: 'START_GENERATION' });
    llmDispatch({ type: 'CLEAR_STREAM' });

    const relText = relatedEdges
      .map(e => {
        const other = nodes.find(n => n.id === (e.source === node.id ? e.target : e.source));
        const dir = e.source === node.id ? '→' : '←';
        return `${dir} ${e.label} ${other?.label || ''}`;
      })
      .join(', ');

    const userMsg = `Node: "${node.label}" (type: ${node.type})\nRelationships: ${relText || 'none'}`;

    try {
      const res = await ollamaFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: llmState.model,
          messages: [
            { role: 'system', content: DESC_SYSTEM },
            { role: 'user', content: userMsg }
          ],
          stream: true
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let accumulated = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value).split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            if (json.message?.content) {
              llmDispatch({ type: 'UPDATE_STREAM', payload: json.message.content });
              accumulated += json.message.content;
            }
          } catch {}
        }
      }
      llmDispatch({ type: 'FINISH_GENERATION' });
      return accumulated;
    } catch (err) {
      llmDispatch({ type: 'SET_ERROR', payload: err.message });
      return null;
    }
  };

  const extractGraphFromChunk = async (chunkText) => {
    const res = await ollamaFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: llmState.model,
        messages: [
          { role: 'system', content: GRAPH_SYSTEM },
          { role: 'user', content: chunkText }
        ],
        stream: false
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const content = data.message?.content || '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  };

  // stream:true로 응답 누적 — 프록시 타임아웃(504) 방지
  const _chatRaw = async (system, user) => {
    const res = await ollamaFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: llmState.model,
        think: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user  },
        ],
        stream: true,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.message?.content) content += json.message.content;
        } catch {}
      }
    }
    return content;
  };

  // JSON 배열을 응답에서 추출 (마크다운 코드블록 포함 대응)
  function extractJsonArray(raw) {
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\[[\s\S]*?\])/);
    const str = m ? (m[1] || m[0]) : raw;
    try { return JSON.parse(str.trim()); } catch { return null; }
  }

  const suggestConnections = async (targetNodes, allNodes, existingEdges) => {
    const SYSTEM = `You are an ontology graph expert. Output ONLY a valid JSON array, no explanation, no markdown.
Format: [{"source":"nodeId","target":"nodeId","label":"relation"}]
Example: [{"source":"n1","target":"n2","label":"소속"}]
Rules: up to 15 pairs, no duplicate existing edges, labels in Korean (2-8 chars).`;

    const targetList  = targetNodes.map(n => `id=${n.id} "${n.label}"(${n.type})`).join('\n');
    const allList     = allNodes.slice(0, 60).map(n => `id=${n.id} "${n.label}"(${n.type})`).join('\n');
    const existingStr = existingEdges.filter(e => !e.inferred).map(e => `${e.source}->${e.target}`).join('\n');

    const raw = await _chatRaw(SYSTEM,
      `Target nodes:\n${targetList}\n\nAll nodes:\n${allList}\n\nExisting (skip duplicates):\n${existingStr || 'none'}`
    );
    const result = extractJsonArray(raw);
    if (!Array.isArray(result)) throw new Error('모델이 유효한 JSON을 반환하지 않았습니다.');
    return result.filter(r => r.source && r.target && r.label);
  };

  const suggestEdgeLabels = async (targetEdges, allNodes) => {
    const SYSTEM = `You are an ontology expert. Output ONLY a valid JSON array, no explanation, no markdown.
Format: [{"id":"edgeId","label":"relation"}]
Example: [{"id":"e1","label":"소속"}]
Rules: Korean labels, 2-8 chars, meaningful relationship names.`;

    const edgeList = targetEdges.map(e => {
      const src = allNodes.find(n => n.id === e.source);
      const tgt = allNodes.find(n => n.id === e.target);
      return `id=${e.id} "${src?.label}"(${src?.type}) → "${tgt?.label}"(${tgt?.type}) current:"${e.label || 'none'}"`;
    }).join('\n');

    const raw = await _chatRaw(SYSTEM, `Edges:\n${edgeList}`);
    const result = extractJsonArray(raw);
    if (!Array.isArray(result)) throw new Error('모델이 유효한 JSON을 반환하지 않았습니다.');
    return result.filter(r => r.id && r.label);
  };

  const enrichNode = async (node, relatedEdges, allNodes) => {
    if (!llmState.ollamaOnline) return null;

    const relText = relatedEdges.map(e => {
      const other = allNodes.find(n => n.id === (e.source === node.id ? e.target : e.source));
      const dir = e.source === node.id ? '→' : '←';
      return `${dir} "${other?.label}"(${other?.type}) [${e.label}]`;
    }).join('\n') || '없음';

    const SYSTEM = `당신은 온톨로지 전문가입니다.
주어진 노드를 풍부하게 만들 신규 노드와 관계를 제안하세요.
- Class: 관련 Instance와 Literal 속성값 제안
- Instance: Literal 속성값, 상위 Class, 연관 Instance 제안
- Literal: 관련 Instance나 Class 제안
신규 노드 ID는 enrich_0, enrich_1... 형식 사용. 최대 5개 신규 노드, 최대 8개 관계.
JSON만 반환:
{"nodes":[{"id":"enrich_0","label":"이름","type":"Class|Instance|Literal","properties":[],"description":"설명"}],"edges":[{"source":"<id>","target":"<id>","label":"관계명"}]}`;

    const userMsg = `노드: "${node.label}" (타입: ${node.type}, ID: ${node.id})
속성: ${node.properties?.map(p => `${p.key}=${p.value}`).join(', ') || '없음'}
기존 연결:
${relText}`;

    try {
      const raw = await _chatRaw(SYSTEM, userMsg);
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      return JSON.parse(m[0]);
    } catch { return null; }
  };

  return {
    generateGraph,
    generateDescription,
    extractGraphFromChunk,
    suggestConnections,
    suggestEdgeLabels,
    enrichNode,
    isGenerating: llmState.isGenerating,
    ollamaOnline: llmState.ollamaOnline,
    ollamaUrl: llmState.ollamaUrl,
    model: llmState.model,
    availableModels: llmState.availableModels,
    streamedContent: llmState.streamedContent,
    error: llmState.error,
  };
}

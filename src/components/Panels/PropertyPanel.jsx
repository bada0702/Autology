import React, { useContext, useState, useEffect } from 'react';
import { X, Plus, Trash2, Sparkles, Zap } from 'lucide-react';
import GraphContext from '../../context/GraphContext';
import LLMContext from '../../context/LLMContext';
import { useOllama } from '../../hooks/useOllama';
import { NODE_COLORS } from '../../constants/nodeTypes';
import './PropertyPanel.css';

export default function PropertyPanel() {
  const { state, dispatch } = useContext(GraphContext);
  const { state: llm }     = useContext(LLMContext);
  const { generateDescription, enrichNode, streamedContent, isGenerating } = useOllama();

  const selectedNode = state.nodes.find(n => n.id === state.selectedId);
  const selectedEdge = state.edges.find(e => e.id === state.selectedId);

  const [label, setLabel]             = useState('');
  const [type,  setType]              = useState('Class');
  const [showDesc, setShowDesc]       = useState(false);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [enrichPreview, setEnrichPreview] = useState(null);

  useEffect(() => {
    if (selectedNode) {
      setLabel(selectedNode.label);
      setType(selectedNode.type);
      setShowDesc(false);
      setEnrichPreview(null);
    }
  }, [selectedNode?.id]);

  if (!selectedNode && !selectedEdge) return null;

  // ── Edge panel ────────────────────────────────────────────
  if (selectedEdge) {
    const srcNode = state.nodes.find(n => n.id === selectedEdge.source);
    const tgtNode = state.nodes.find(n => n.id === selectedEdge.target);
    return (
      <aside className="prop-panel glass">
        <div className="prop-header">
          <span className="prop-header-title">관계 (Edge)</span>
          <button className="prop-close" onClick={() => dispatch({ type: 'SET_SELECTED', payload: null })}><X size={15} /></button>
        </div>
        <div className="prop-body">
          <div className="edge-info">
            <EdgeNode node={srcNode} />
            <div className="edge-arrow">{selectedEdge.direction === 'both' ? '↔' : '→'}</div>
            <EdgeNode node={tgtNode} />
          </div>
          <div className="prop-field">
            <label>레이블</label>
            <input
              value={selectedEdge.label}
              onChange={e => dispatch({ type: 'UPDATE_EDGE', payload: { id: selectedEdge.id, updates: { label: e.target.value } } })}
              placeholder="관계 레이블..."
            />
          </div>
          <div className="prop-field">
            <label>방향</label>
            <select
              value={selectedEdge.direction || 'forward'}
              onChange={e => dispatch({ type: 'UPDATE_EDGE', payload: { id: selectedEdge.id, updates: { direction: e.target.value } } })}
            >
              <option value="forward">단방향 (→)</option>
              <option value="both">양방향 (↔)</option>
            </select>
          </div>
          <div className="prop-field">
            <label>스타일</label>
            <select
              value={selectedEdge.style || 'solid'}
              onChange={e => dispatch({ type: 'UPDATE_EDGE', payload: { id: selectedEdge.id, updates: { style: e.target.value } } })}
            >
              <option value="solid">실선 (Solid)</option>
              <option value="dashed">점선 (Dashed)</option>
            </select>
          </div>
          <button
            className="prop-danger-btn"
            onClick={() => dispatch({ type: 'DELETE_EDGE', payload: selectedEdge.id })}
          >
            <Trash2 size={13} /> 관계 삭제
          </button>
        </div>
      </aside>
    );
  }

  // ── Node panel ────────────────────────────────────────────
  const color = NODE_COLORS[selectedNode.type] || '#818cf8';

  const updateLabel = (v) => {
    setLabel(v);
    dispatch({ type: 'UPDATE_NODE', payload: { id: selectedNode.id, updates: { label: v } } });
  };

  const updateType = (v) => {
    setType(v);
    dispatch({ type: 'UPDATE_NODE', payload: { id: selectedNode.id, updates: { type: v } } });
  };

  const addProp = () => {
    const props = [...(selectedNode.properties || []), { key: '', value: '' }];
    dispatch({ type: 'UPDATE_NODE', payload: { id: selectedNode.id, updates: { properties: props } } });
  };

  const updateProp = (i, field, val) => {
    const props = [...selectedNode.properties];
    props[i] = { ...props[i], [field]: val };
    dispatch({ type: 'UPDATE_NODE', payload: { id: selectedNode.id, updates: { properties: props } } });
  };

  const deleteProp = (i) => {
    const props = selectedNode.properties.filter((_, idx) => idx !== i);
    dispatch({ type: 'UPDATE_NODE', payload: { id: selectedNode.id, updates: { properties: props } } });
  };

  const relatedEdges = state.edges.filter(e => e.source === selectedNode.id || e.target === selectedNode.id);

  const handleGenDesc = async () => {
    setShowDesc(true);
    const desc = await generateDescription(selectedNode, relatedEdges, state.nodes);
    if (desc) {
      dispatch({ type: 'UPDATE_NODE', payload: { id: selectedNode.id, updates: { description: desc } } });
    }
  };

  const handleEnrich = async () => {
    setEnrichLoading(true);
    setEnrichPreview(null);
    const result = await enrichNode(selectedNode, relatedEdges, state.nodes);
    setEnrichPreview(result);
    setEnrichLoading(false);
  };

  const handleApplyEnrich = () => {
    if (!enrichPreview) return;
    const now = Date.now();
    const idMap = {};
    state.nodes.forEach(n => { idMap[n.id] = n.id; });

    const newNodes = (enrichPreview.nodes || []).map((n, i) => {
      const finalId = `node_${now}_${i}`;
      idMap[n.id] = finalId;
      return {
        id: finalId,
        label: n.label,
        type: n.type || 'Instance',
        x: selectedNode.x + 220 + (i % 3) * 200,
        y: selectedNode.y - 80 + Math.floor(i / 3) * 140,
        properties: n.properties || [],
        description: n.description || '',
      };
    });

    newNodes.forEach(n => dispatch({ type: 'ADD_NODE', payload: n }));

    (enrichPreview.edges || []).forEach((e, i) => {
      const src = idMap[e.source] || e.source;
      const tgt = idMap[e.target] || e.target;
      if (!src || !tgt || src === tgt) return;
      dispatch({
        type: 'ADD_EDGE',
        payload: { id: `edge_${now}_${i}`, source: src, target: tgt, label: e.label || '', style: 'solid', inferred: false },
      });
    });

    setEnrichPreview(null);
  };

  return (
    <aside className="prop-panel glass">
      {/* Header */}
      <div className="prop-header" style={{ borderBottom: `2px solid ${color}22` }}>
        <div className="prop-header-node">
          <div className="prop-node-dot" style={{ background: color }} />
          <div>
            <div className="prop-header-label">{selectedNode.label}</div>
            <div className="prop-header-type" style={{ color }}>{selectedNode.type}</div>
          </div>
        </div>
        <button className="prop-close" onClick={() => dispatch({ type: 'SET_SELECTED', payload: null })}><X size={15} /></button>
      </div>

      <div className="prop-body">
        {/* Basic fields */}
        <section className="prop-section">
          <div className="prop-field">
            <label>레이블</label>
            <input value={label} onChange={e => updateLabel(e.target.value)} />
          </div>
          <div className="prop-field">
            <label>타입</label>
            <select value={type} onChange={e => updateType(e.target.value)}>
              <option value="Class">Class — 추상 개념</option>
              <option value="Instance">Instance — 구체 개체</option>
              <option value="Literal">Literal — 값·속성</option>
            </select>
          </div>
        </section>

        <div className="prop-sep" />

        {/* Properties */}
        <section className="prop-section">
          <div className="prop-section-header">
            <span>속성 (Properties)</span>
            <button className="prop-add-btn" onClick={addProp}><Plus size={12} /> 추가</button>
          </div>
          {(selectedNode.properties || []).length === 0 && (
            <p className="prop-empty">속성 없음</p>
          )}
          {(selectedNode.properties || []).map((p, i) => (
            <div key={i} className="prop-kv">
              <input placeholder="key" value={p.key}   onChange={e => updateProp(i, 'key', e.target.value)} />
              <input placeholder="value" value={p.value} onChange={e => updateProp(i, 'value', e.target.value)} />
              <button className="prop-del-btn" onClick={() => deleteProp(i)}><Trash2 size={11} /></button>
            </div>
          ))}
        </section>

        <div className="prop-sep" />

        {/* Connections summary */}
        {relatedEdges.length > 0 && (
          <section className="prop-section">
            <div className="prop-section-header"><span>연결 ({relatedEdges.length})</span></div>
            <div className="prop-connections">
              {relatedEdges.map(e => {
                const other = state.nodes.find(n => n.id === (e.source === selectedNode.id ? e.target : e.source));
                const dir   = e.source === selectedNode.id ? '→' : '←';
                return (
                  <div key={e.id} className="prop-conn-item"
                    onClick={() => dispatch({ type: 'SET_SELECTED', payload: e.id })}
                  >
                    <span className="prop-conn-dir">{dir}</span>
                    <span className="prop-conn-label">{e.label || 'relation'}</span>
                    <span className="prop-conn-node" style={{ color: NODE_COLORS[other?.type] }}>{other?.label}</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <div className="prop-sep" />

        {/* AI description */}
        <section className="prop-section">
          <button
            className="prop-ai-btn"
            onClick={handleGenDesc}
            disabled={isGenerating || !llm.ollamaOnline}
          >
            {isGenerating ? <span className="ai-spinner" /> : <Sparkles size={13} />}
            {isGenerating ? 'AI 설명 생성 중...' : 'AI 설명 생성'}
          </button>
          {!llm.ollamaOnline && <p className="prop-warn">Ollama 오프라인</p>}

          {(showDesc || selectedNode.description) && (
            <div className="prop-desc-box">
              {isGenerating ? streamedContent : (streamedContent || selectedNode.description)}
              {isGenerating && <span className="ai-cursor">▌</span>}
            </div>
          )}
        </section>

        <div className="prop-sep" />

        {/* AI 정보 추가 생성 */}
        <section className="prop-section">
          <button
            className="prop-ai-btn prop-ai-btn--enrich"
            onClick={handleEnrich}
            disabled={enrichLoading || !llm.ollamaOnline}
          >
            {enrichLoading ? <span className="ai-spinner" /> : <Zap size={13} />}
            {enrichLoading ? 'AI 정보 추가 생성 중...' : 'AI 정보 추가 생성'}
          </button>

          {enrichPreview && (
            <div className="prop-enrich-preview">
              <div className="prop-enrich-header">
                <span>
                  {(enrichPreview.nodes?.length || 0)}개 노드 · {(enrichPreview.edges?.length || 0)}개 관계 제안
                </span>
                <button className="prop-close" onClick={() => setEnrichPreview(null)}><X size={11} /></button>
              </div>
              {(enrichPreview.nodes || []).map((n, i) => (
                <div key={i} className="prop-enrich-item">
                  <span className={`prop-enrich-badge prop-enrich-badge--${(n.type || 'instance').toLowerCase()}`}>
                    {(n.type || 'I')[0]}
                  </span>
                  <span className="prop-enrich-label">{n.label}</span>
                </div>
              ))}
              {(enrichPreview.edges || []).map((e, i) => {
                const allNodes = [...state.nodes, ...(enrichPreview.nodes || [])];
                const src = allNodes.find(n => n.id === e.source);
                const tgt = allNodes.find(n => n.id === e.target);
                return (
                  <div key={i} className="prop-enrich-edge">
                    <span>{src?.label || e.source}</span>
                    <span className="prop-enrich-arrow">—[{e.label}]→</span>
                    <span>{tgt?.label || e.target}</span>
                  </div>
                );
              })}
              <button className="prop-ai-btn" style={{ marginTop: 4 }} onClick={handleApplyEnrich}>
                <Plus size={12} /> 그래프에 적용
              </button>
            </div>
          )}

          {!enrichPreview && !enrichLoading && !llm.ollamaOnline && (
            <p className="prop-warn">Ollama 오프라인</p>
          )}
        </section>

        <div className="prop-sep" />

        <button
          className="prop-danger-btn"
          onClick={() => dispatch({ type: 'DELETE_NODE', payload: selectedNode.id })}
        >
          <Trash2 size={13} /> 노드 삭제
        </button>
      </div>
    </aside>
  );
}

function EdgeNode({ node }) {
  if (!node) return <span className="edge-info-node">?</span>;
  const color = NODE_COLORS[node.type] || '#818cf8';
  return (
    <div className="edge-info-node" style={{ borderColor: color + '66' }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ color: '#eef2ff', fontSize: 11 }}>{node.label}</span>
    </div>
  );
}

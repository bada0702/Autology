import React, { useCallback, useContext, useEffect, useState } from 'react';
import GraphContext from '../../context/GraphContext';
import { forceLayout } from '../../utils/layout';
import {
  linkEntities, getKnowledgeStats, ingestKnowledge, getKnowledgeGraph,
  getKnowledgeSubgraph, deleteKnowledgeSource,
} from '../../utils/semanticApi';
import ExploreSection from './ExploreSection';
import './RulePanel.css';
import './KnowledgePanel.css';

// Knowledge base: accumulate generated graphs, merge entities across runs,
// and load the whole base or a neighbourhood back onto the canvas.
export default function KnowledgePanel() {
  const { state: graph, dispatch } = useContext(GraphContext);
  const [stats, setStats] = useState(null);
  const [topic, setTopic] = useState('');
  const [query, setQuery] = useState('');
  const [hops, setHops] = useState(1);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);   // { kind: 'ok'|'error', lines: [] }
  const [armed, setArmed] = useState('');         // two-step confirm for destructive actions

  const refresh = useCallback(async () => {
    try { setStats(await getKnowledgeStats()); } catch (err) { setStats({ error: err.message }); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (key, fn) => {
    setBusy(key);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ kind: 'error', lines: [err.message] });
    } finally {
      setBusy('');
      setArmed('');
    }
  };

  // Destructive actions need a second click instead of a blocking dialog.
  const confirmFirst = (key, fn) => {
    if (armed !== key) { setArmed(key); return; }
    run(key, fn);
  };

  const handleLinkEntities = () => run('link', async () => {
    const { summary, graph: linked } = await linkEntities(graph, topic);
    const byId = Object.fromEntries(linked.nodes.map(n => [n.id, n]));
    for (const n of graph.nodes) {
      const l = byId[n.id];
      if (l?.wikidata_id && l.wikidata_id !== n.wikidata_id) {
        dispatch({ type: 'UPDATE_NODE', payload: { id: n.id, updates: {
          wikidata_id: l.wikidata_id,
          wikidata_label: l.wikidata_label,
          wikidata_description: l.wikidata_description,
        } } });
      }
    }
    const linkedEntries = Object.entries(summary.linked || {});
    setMessage({ kind: 'ok', lines: [
      `Wikidata 연결 ${linkedEntries.length}개 · 미연결 ${(summary.unlinked || []).length}개`,
      ...linkedEntries.slice(0, 6).map(([label, qid]) => `${label} → ${qid}`),
    ] });
  });

  const handleIngest = () => run('ingest', async () => {
    const r = await ingestKnowledge(graph, topic || '이름 없는 그래프');
    setMessage({ kind: 'ok', lines: [
      `노드 추가 ${r.nodes_added} · 병합 ${r.nodes_merged} · 엣지 추가 ${r.edges_added} (기존 ${r.edges_existing})`,
      ...r.merges.slice(0, 6).map(m => `병합: ${m.label} → ${m.into} (${m.reason})`),
      ...r.conflicts.slice(0, 4).map(c => `속성 충돌: ${c.node}.${c.property} = ${c.existing} / ${c.incoming}`),
    ] });
    await refresh();
  });

  const loadOntoCanvas = (data, highlightIds = [], highlightEdgeIds = []) => {
    const positions = forceLayout(data.nodes, data.edges);
    const nodes = data.nodes.map(n => ({ ...n, ...(positions[n.id] || {}) }));
    dispatch({ type: 'LOAD_GRAPH', payload: { nodes, edges: data.edges } });
    if (highlightIds.length) {
      dispatch({ type: 'SET_HIGHLIGHT', payload: { nodeIds: highlightIds, edgeIds: highlightEdgeIds } });
    }
  };

  const handleLoadAll = () => confirmFirst('loadAll', async () => {
    const data = await getKnowledgeGraph();
    loadOntoCanvas(data);
    setMessage({ kind: 'ok', lines: [`지식 베이스 전체를 불러왔습니다: 노드 ${data.nodes.length} · 엣지 ${data.edges.length}`] });
  });

  const handleLoadNeighbourhood = () => confirmFirst('loadSub', async () => {
    const data = await getKnowledgeSubgraph(query, hops);
    if (!data.nodes.length) {
      setMessage({ kind: 'error', lines: [`"${query}"와 일치하는 노드가 없습니다.`] });
      return;
    }
    loadOntoCanvas(data, data.seeds);
    setMessage({ kind: 'ok', lines: [`"${query}" 주변 ${hops}단계: 노드 ${data.nodes.length} · 엣지 ${data.edges.length}`] });
  });

  const handleDeleteSource = (src) => confirmFirst(`del:${src.id}`, async () => {
    const r = await deleteKnowledgeSource(src.id);
    setMessage({ kind: 'ok', lines: [`"${src.topic}" 제거: 노드 ${r.nodes_deleted} · 엣지 ${r.edges_deleted} 삭제`] });
    await refresh();
  });

  const empty = graph.nodes.length === 0;
  const confirmLabel = (key, label) => (armed === key ? '한 번 더 클릭: 캔버스 교체' : label);

  return (
    <div className="rule-panel kb-panel">
      <div className="rule-header">
        <span className="rule-title">지식 베이스</span>
        {stats && !stats.error && (
          <span className="rule-badge">{stats.nodes} 노드 · {stats.edges} 엣지</span>
        )}
      </div>

      <div className="kb-section">
        <div className="kb-label">현재 캔버스</div>
        <input
          className="rule-input kb-input"
          placeholder="출처 이름 (예: 생성 주제)"
          value={topic}
          onChange={e => setTopic(e.target.value)}
        />
        <div className="kb-row">
          <button className="rule-apply-btn" disabled={empty || !!busy} onClick={handleLinkEntities}
            title="노드를 Wikidata 항목에 연결합니다. 같은 항목에 연결된 노드는 저장할 때 하나로 병합됩니다.">
            {busy === 'link' ? '연결 중…' : '🔗 엔티티 연결'}
          </button>
          <button className="rule-apply-btn" disabled={empty || !!busy} onClick={handleIngest}
            title="현재 그래프를 지식 베이스에 누적합니다 (같은 개체는 병합).">
            {busy === 'ingest' ? '저장 중…' : '💾 저장'}
          </button>
        </div>
      </div>

      <div className="kb-section">
        <div className="kb-label">불러오기 (캔버스를 교체합니다)</div>
        <div className="kb-row">
          <input
            className="rule-input kb-input"
            placeholder="노드 이름 · 별칭 · Q-id"
            value={query}
            onChange={e => { setQuery(e.target.value); setArmed(''); }}
            onKeyDown={e => { if (e.key === 'Enter' && query.trim()) handleLoadNeighbourhood(); }}
          />
          <select className="rule-select kb-hops" value={hops} onChange={e => setHops(Number(e.target.value))}
            title="몇 단계 이웃까지 불러올지">
            {[0, 1, 2, 3].map(h => <option key={h} value={h}>{h}단계</option>)}
          </select>
        </div>
        <div className="kb-row">
          <button className="rule-apply-btn" disabled={!query.trim() || !!busy} onClick={handleLoadNeighbourhood}>
            {confirmLabel('loadSub', '🔎 주변 불러오기')}
          </button>
          <button className="rule-apply-btn" disabled={!stats?.nodes || !!busy} onClick={handleLoadAll}>
            {confirmLabel('loadAll', '📥 전체')}
          </button>
        </div>
      </div>

      <ExploreSection onLoad={loadOntoCanvas} busy={busy} setBusy={setBusy} setMessage={setMessage} />

      {message && (
        <div className={`kb-message kb-message--${message.kind}`}>
          {message.lines.map((line, i) => <p key={i}>{line}</p>)}
        </div>
      )}

      <div className="kb-section kb-sources">
        <div className="kb-label">
          출처 {stats?.sources?.length ?? 0}개
          {stats?.linked_nodes ? ` · Wikidata 연결 노드 ${stats.linked_nodes}` : ''}
        </div>
        {stats?.error && <p className="rule-empty">지식 베이스에 연결할 수 없습니다: {stats.error}</p>}
        {stats?.sources?.length === 0 && <p className="rule-empty">아직 저장된 그래프가 없습니다.</p>}
        {(stats?.sources || []).map(src => (
          <div key={src.id} className="kb-source">
            <div className="kb-source-info">
              <span className="kb-source-topic">{src.topic || '(이름 없음)'}</span>
              <span className="kb-source-meta">
                {new Date(src.created * 1000).toLocaleString()} · 노드 {src.node_count} · 엣지 {src.edge_count}
              </span>
            </div>
            <button
              className={`rule-del-btn${armed === `del:${src.id}` ? ' kb-armed' : ''}`}
              onClick={() => handleDeleteSource(src)}
              title={armed === `del:${src.id}` ? '한 번 더 클릭하면 이 출처만 기여한 노드·엣지가 삭제됩니다' : '이 출처 제거'}
              disabled={!!busy}
            >{armed === `del:${src.id}` ? '삭제?' : '×'}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

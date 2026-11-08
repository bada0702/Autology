import React, { useContext, useState } from 'react';
import GraphContext from '../../context/GraphContext';
import { explorePaths, exploreFacts, getKnowledgeSubgraph } from '../../utils/semanticApi';

// Proof tree for an inferred fact: rules at inner nodes, asserted edges
// (with the sources they came from) at the leaves.
function Derivation({ node, depth = 0 }) {
  if (!node) return null;
  return (
    <div className="kb-deriv" style={{ marginLeft: depth ? 10 : 0 }}>
      <span className={node.asserted ? 'kb-deriv-leaf' : 'kb-deriv-rule'}>
        {node.asserted ? '■ ' : '◇ '}{node.statement}
        {node.rule && <em> ← {node.rule_text}({node.rule})</em>}
        {node.asserted && node.sources?.length > 0 && (
          <em> · {node.sources.map(s => s.topic || s.id).join(', ')}</em>
        )}
        {node.original_label && <em> · 원문 "{node.original_label}"</em>}
        {node.truncated && <em> …</em>}
      </span>
      {(node.premises || []).map((p, i) => <Derivation key={i} node={p} depth={depth + 1} />)}
    </div>
  );
}

function FactLine({ fact }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="kb-fact">
      <span
        className={`kb-fact-text${fact.inferred ? ' kb-fact-text--inferred' : ''}`}
        onClick={() => fact.inferred && setOpen(o => !o)}
        title={fact.inferred ? '클릭: 추론 근거 보기' : (fact.sources || []).map(s => s.topic).join(', ')}
      >
        {fact.inferred ? (open ? '▾ ' : '▸ ') : '• '}{fact.statement}
        {fact.inferred && <span className="kb-tag">추론</span>}
        {fact.wikidata?.id && <span className="kb-tag">{fact.wikidata.id}</span>}
      </span>
      {open && <Derivation node={fact.derivation} />}
    </div>
  );
}

// "How is A connected to B?" and "What do we know about A?" over the canvas
// graph or the knowledge base, with every answer traced to its evidence.
export default function ExploreSection({ onLoad, busy, setBusy, setMessage }) {
  const { state: graph, dispatch } = useContext(GraphContext);
  const [scope, setScope] = useState('canvas');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [maxHops, setMaxHops] = useState(4);
  const [directed, setDirected] = useState(false);
  const [result, setResult] = useState(null);   // { kind: 'paths'|'facts', ... }
  const [selected, setSelected] = useState(-1);
  const [armed, setArmed] = useState(-1);

  const source = () => (scope === 'canvas' ? graph : null);

  const run = async (key, fn) => {
    setBusy(key);
    setMessage(null);
    setSelected(-1);
    setArmed(-1);
    try { await fn(); } catch (err) { setMessage({ kind: 'error', lines: [err.message] }); }
    finally { setBusy(''); }
  };

  const describeMatches = (label, query, matches) =>
    !matches.length ? [`${label} "${query}"와 일치하는 노드가 없습니다.`]
      : matches.length > 1 ? [`${label} "${query}" 후보 ${matches.length}개: ${matches.slice(0, 4).map(m => m.label).join(', ')}`]
        : [];

  const handlePaths = () => run('paths', async () => {
    const r = await explorePaths(from, to, source(), { max_hops: maxHops, directed, max_paths: 8 });
    const notes = [...describeMatches('출발', from, r.source_matches), ...describeMatches('도착', to, r.target_matches)];
    if (!r.paths.length) {
      setResult(null);
      setMessage({ kind: 'error', lines: [...notes,
        notes.length && !(r.source_matches.length && r.target_matches.length)
          ? '' : `${maxHops}단계 안에 연결된 경로가 없습니다.`].filter(Boolean) });
      return;
    }
    if (notes.length) setMessage({ kind: 'ok', lines: notes });
    setResult({ kind: 'paths', ...r });
  });

  const handleFacts = () => run('facts', async () => {
    const r = await exploreFacts(from, source());
    if (!r.facts.length) {
      setResult(null);
      setMessage({ kind: 'error', lines: [r.matches.length ? `"${from}"에 대해 알려진 사실이 없습니다.`
        : `"${from}"와 일치하는 노드가 없습니다.`] });
      return;
    }
    setResult({ kind: 'facts', ...r });
  });

  // Canvas scope: highlight the path and the asserted edges behind it.
  // Knowledge base scope: load just those nodes onto the canvas (second click).
  const selectPath = async (p, i) => {
    if (scope === 'canvas') {
      setSelected(i);
      dispatch({ type: 'SET_HIGHLIGHT', payload: { nodeIds: p.evidence_node_ids, edgeIds: p.evidence_edge_ids } });
      return;
    }
    if (armed !== i) { setArmed(i); return; }
    setArmed(-1);
    setBusy('loadPath');
    try {
      const data = await getKnowledgeSubgraph('', 0, p.evidence_node_ids);
      onLoad(data, p.nodes, p.evidence_edge_ids);
      setSelected(i);
    } catch (err) {
      setMessage({ kind: 'error', lines: [err.message] });
    } finally { setBusy(''); }
  };

  const canSearch = scope === 'knowledge' || graph.nodes.length > 0;

  return (
    <>
      <div className="kb-section">
        <div className="kb-label">경로 탐색 · 근거 추적</div>
        <div className="kb-row">
          <select className="rule-select kb-scope" value={scope}
            onChange={e => { setScope(e.target.value); setResult(null); }}>
            <option value="canvas">캔버스</option>
            <option value="knowledge">지식 베이스</option>
          </select>
          <select className="rule-select kb-hops" value={maxHops} onChange={e => setMaxHops(Number(e.target.value))}
            title="최대 단계 수">
            {[1, 2, 3, 4, 5, 6].map(h => <option key={h} value={h}>{h}단계</option>)}
          </select>
          <label className="kb-check" title="관계 방향을 따라서만 이동">
            <input type="checkbox" checked={directed} onChange={e => setDirected(e.target.checked)} /> 방향
          </label>
        </div>
        <input className="rule-input kb-input" placeholder="출발 노드 (또는 사실을 볼 노드)"
          value={from} onChange={e => setFrom(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && from.trim()) (to.trim() ? handlePaths() : handleFacts()); }} />
        <input className="rule-input kb-input" placeholder="도착 노드"
          value={to} onChange={e => setTo(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && from.trim() && to.trim()) handlePaths(); }} />
        <div className="kb-row">
          <button className="rule-apply-btn" disabled={!canSearch || !from.trim() || !to.trim() || !!busy}
            onClick={handlePaths} title="두 노드를 잇는 경로를 찾습니다 (추론된 관계 포함)">
            {busy === 'paths' ? '탐색 중…' : '🧭 경로 찾기'}
          </button>
          <button className="rule-apply-btn" disabled={!canSearch || !from.trim() || !!busy}
            onClick={handleFacts} title="출발 노드에 대해 알려진 사실과 근거">
            {busy === 'facts' ? '조회 중…' : '📋 사실 보기'}
          </button>
        </div>
      </div>

      {result?.kind === 'paths' && (
        <div className="kb-section kb-results">
          <div className="kb-label">
            경로 {result.paths.length}개{result.truncated ? ' (일부만 표시)' : ''}
            {scope === 'knowledge' ? ' · 두 번 클릭하면 캔버스에 불러옵니다' : ' · 클릭하면 근거를 강조합니다'}
          </div>
          {result.paths.map((p, i) => (
            <div key={i} className={`kb-path${selected === i ? ' kb-path--selected' : ''}`}>
              <div className="kb-path-head" onClick={() => !busy && selectPath(p, i)}>
                <span className="kb-path-text">{armed === i ? '한 번 더 클릭: 캔버스 교체' : p.text}</span>
                <span className="kb-source-meta">
                  {p.hops}단계{p.inferred_steps ? ` · 추론 ${p.inferred_steps}` : ''}
                  {p.sources.length ? ` · 출처 ${p.sources.map(s => s.topic).join(', ')}` : ''}
                </span>
              </div>
              {selected === i && p.steps.map((s, j) => (
                <div key={j} className="kb-step">
                  {s.facts.map((f, k) => <FactLine key={k} fact={f} />)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {result?.kind === 'facts' && (
        <div className="kb-section kb-results">
          <div className="kb-label">
            {result.matches.map(m => m.label).join(', ')}: 사실 {result.facts.length}개
            (직접 {result.facts.filter(f => !f.inferred).length} · 추론 {result.facts.filter(f => f.inferred).length})
          </div>
          {result.facts.map((f, i) => <FactLine key={i} fact={f} />)}
        </div>
      )}
    </>
  );
}

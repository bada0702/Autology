import React, { useContext, useMemo, useState } from 'react';
import { X, AlertTriangle, CheckCircle, Info, Sparkles, GitMerge, Activity, Camera, RotateCcw, Trash2 } from 'lucide-react';
import GraphContext from '../../context/GraphContext';
import { useOllama } from '../../hooks/useOllama';
import { detectSimilarNodes, buildNormalizedLabels } from '../../utils/entityNormalizer';
import { findShortestPath, calculateCentrality, getNHopSubgraph } from '../../utils/graphAnalysis';
import './GraphInspector.css';

function countBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key] || '(없음)';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

export default function GraphInspector({ onClose }) {
  const { state, dispatch } = useContext(GraphContext);
  const { nodes, edges } = state;
  const { generateDescription, suggestConnections, suggestEdgeLabels, ollamaOnline } = useOllama();
  const [descProgress, setDescProgress]         = useState(null);
  const [connSuggestions, setConnSuggestions]   = useState(null); // null | {source,target,label}[]
  const [connRunning, setConnRunning]           = useState(false);
  const [labelSuggestions, setLabelSuggestions] = useState(null); // null | {id,label,oldLabel}[]
  const [labelRunning, setLabelRunning]         = useState(false);
  const [dismissedConn, setDismissedConn]       = useState(new Set());
  const [dismissedLbl, setDismissedLbl]         = useState(new Set());
  const [mergeSuggestions, setMergeSuggestions] = useState(null); // null = not run yet
  const [dismissed, setDismissed]           = useState(new Set());
  const [pathSrcId, setPathSrcId]           = useState('');
  const [pathTgtId, setPathTgtId]           = useState('');
  const [pathResult, setPathResult]         = useState(null); // null | [] | nodeId[]
  const [hopCenter, setHopCenter]           = useState('');
  const [hopN, setHopN]                     = useState(2);
  const [snapName, setSnapName]             = useState('');
  const [normalizeMsg, setNormalizeMsg]     = useState('');
  const [connError, setConnError]           = useState('');
  const [labelError, setLabelError]         = useState('');

  const stats = useMemo(() => {
    const nodesByType = countBy(nodes, 'type');
    const edgesByLabel = countBy(edges, 'label');

    const isolated = nodes.filter(n =>
      !edges.some(e => e.source === n.id || e.target === n.id)
    );

    const labels = nodes.map(n => n.label.toLowerCase());
    const dupLabels = [...new Set(labels.filter((l, i) => labels.indexOf(l) !== i))];

    const noDesc = nodes.filter(n => !n.description);

    const inferredEdges = edges.filter(e => e.inferred);

    return { nodesByType, edgesByLabel, isolated, dupLabels, noDesc, inferredEdges };
  }, [nodes, edges]);

  const issues = [
    stats.isolated.length > 0 && {
      level: 'warn',
      title: `고립된 노드 ${stats.isolated.length}개`,
      items: stats.isolated.map(n => n.label),
    },
    stats.dupLabels.length > 0 && {
      level: 'warn',
      title: `중복 레이블 ${stats.dupLabels.length}개`,
      items: stats.dupLabels,
    },
    nodes.length === 0 && {
      level: 'warn',
      title: '그래프가 비어 있습니다.',
      items: [],
    },
  ].filter(Boolean);

  const handleDetectSimilar = () => {
    const found = detectSimilarNodes(nodes);
    setMergeSuggestions(found);
    setDismissed(new Set());
  };

  const handleAcceptMerge = (sug) => {
    // Keep nodeB (the second node), merge nodeA into it
    dispatch({ type: 'ACCEPT_MERGE', payload: { sourceId: sug.nodeA.id, targetId: sug.nodeB.id } });
    setDismissed(prev => new Set([...prev, sug.id]));
    // Re-run detection on updated nodes
    setMergeSuggestions(prev => prev ? prev.filter(s => s.id !== sug.id && s.nodeA.id !== sug.nodeA.id && s.nodeB.id !== sug.nodeA.id) : null);
  };

  const handleRejectMerge = (id) => {
    setDismissed(prev => new Set([...prev, id]));
  };

  const centrality = useMemo(() => {
    if (nodes.length === 0) return [];
    const deg = calculateCentrality(nodes, edges);
    return nodes
      .map(n => ({ ...n, degree: deg[n.id] || 0 }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 8);
  }, [nodes, edges]);

  const handleFindPath = () => {
    if (!pathSrcId || !pathTgtId) return;
    const path = findShortestPath(nodes, edges, pathSrcId, pathTgtId);
    setPathResult(path);
    if (path) {
      const pathSet = new Set(path);
      const pathEdges = edges.filter(e => pathSet.has(e.source) && pathSet.has(e.target)).map(e => e.id);
      dispatch({ type: 'SET_HIGHLIGHT', payload: { nodeIds: path, edgeIds: pathEdges } });
    } else {
      dispatch({ type: 'CLEAR_HIGHLIGHT' });
    }
  };

  const handleHopSubgraph = () => {
    if (!hopCenter) return;
    const { nodeIds, edgeIds } = getNHopSubgraph(nodes, edges, hopCenter, hopN);
    dispatch({ type: 'SET_HIGHLIGHT', payload: { nodeIds: [...nodeIds], edgeIds: [...edgeIds] } });
  };

  const handleClearAnalysis = () => {
    setPathResult(null);
    dispatch({ type: 'CLEAR_HIGHLIGHT' });
  };

  const handleTakeSnapshot = () => {
    dispatch({ type: 'TAKE_SNAPSHOT', payload: snapName.trim() || undefined });
    setSnapName('');
  };

  const handleNormalizeLabels = () => {
    const labelMap = buildNormalizedLabels(nodes);
    const changedCount = nodes.filter(n => labelMap[n.id] !== n.label).length;
    dispatch({ type: 'NORMALIZE_LABELS', payload: labelMap });
    setNormalizeMsg(changedCount === 0
      ? '모든 레이블이 이미 정규화되어 있습니다.'
      : `${changedCount}개 레이블이 정규화되었습니다.`
    );
    setTimeout(() => setNormalizeMsg(''), 3000);
  };

  const handleSuggestConnections = async () => {
    if (!ollamaOnline || nodes.length < 2) return;
    setConnRunning(true);
    setConnSuggestions(null);
    setConnError('');
    setDismissedConn(new Set());
    try {
      const isolated = stats.isolated.length > 0 ? stats.isolated : nodes;
      const sugg = await suggestConnections(isolated, nodes, edges);
      setConnSuggestions(sugg);
    } catch (e) {
      setConnError(e.message || 'AI 분석 중 오류가 발생했습니다.');
      setConnSuggestions([]);
    }
    setConnRunning(false);
  };

  const handleAcceptConn = (s, idx) => {
    dispatch({
      type: 'ADD_EDGE',
      payload: {
        id: `ai_edge_${Date.now()}_${idx}`,
        source: s.source,
        target: s.target,
        label: s.label,
        style: 'solid',
        direction: 'forward',
        inferred: false,
      },
    });
    setDismissedConn(prev => new Set([...prev, idx]));
  };

  const handleSuggestLabels = async () => {
    if (!ollamaOnline || edges.length === 0) return;
    setLabelRunning(true);
    setLabelSuggestions(null);
    setLabelError('');
    setDismissedLbl(new Set());
    try {
      const targets = edges.filter(e => !e.inferred && (!e.label || e.label.trim().length <= 2));
      const source  = targets.length >= 3 ? targets : edges.filter(e => !e.inferred).slice(0, 20);
      const sugg = await suggestEdgeLabels(source, nodes);
      const enriched = sugg.map(s => ({
        ...s,
        oldLabel: edges.find(e => e.id === s.id)?.label || '',
      }));
      setLabelSuggestions(enriched);
    } catch (e) {
      setLabelError(e.message || 'AI 분석 중 오류가 발생했습니다.');
      setLabelSuggestions([]);
    }
    setLabelRunning(false);
  };

  const handleAcceptLabel = (s) => {
    dispatch({ type: 'UPDATE_EDGE', payload: { id: s.id, updates: { label: s.label } } });
    setDismissedLbl(prev => new Set([...prev, s.id]));
  };

  const handleFillDescriptions = async () => {
    const targets = stats.noDesc;
    if (!targets.length || !ollamaOnline) return;
    setDescProgress({ current: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      const node = targets[i];
      setDescProgress({ current: i + 1, total: targets.length });
      const relatedEdges = edges.filter(e => e.source === node.id || e.target === node.id);
      const desc = await generateDescription(node, relatedEdges, nodes);
      if (desc) {
        dispatch({ type: 'UPDATE_NODE', payload: { id: node.id, updates: { description: desc } } });
      }
    }
    setDescProgress(null);
  };

  const infos = [
    stats.noDesc.length > 0 && {
      title: `설명 없는 노드 ${stats.noDesc.length}개`,
      items: stats.noDesc.slice(0, 8).map(n => n.label),
      isNoDesc: true,
    },
    stats.inferredEdges.length > 0 && {
      title: `추론된 엣지 ${stats.inferredEdges.length}개`,
      items: stats.inferredEdges.slice(0, 8).map(e => e.label),
    },
  ].filter(Boolean);

  return (
    <div className="gi-overlay" onClick={onClose}>
      <div className="gi-modal glass" onClick={e => e.stopPropagation()}>
        <div className="gi-header">
          <span className="gi-title">지식 그래프 검증</span>
          <button className="gi-close" onClick={onClose}><X size={15} /></button>
        </div>

        {/* 통계 */}
        <section className="gi-section">
          <h3 className="gi-section-title">그래프 통계</h3>
          <div className="gi-stat-grid">
            <div className="gi-stat-card">
              <span className="gi-stat-num">{nodes.length}</span>
              <span className="gi-stat-label">전체 노드</span>
            </div>
            <div className="gi-stat-card">
              <span className="gi-stat-num">{edges.length}</span>
              <span className="gi-stat-label">전체 엣지</span>
            </div>
            <div className="gi-stat-card">
              <span className="gi-stat-num" style={{ color: '#60a5fa' }}>{stats.nodesByType['Class'] || 0}</span>
              <span className="gi-stat-label">Class</span>
            </div>
            <div className="gi-stat-card">
              <span className="gi-stat-num" style={{ color: '#4ade80' }}>{stats.nodesByType['Instance'] || 0}</span>
              <span className="gi-stat-label">Instance</span>
            </div>
            <div className="gi-stat-card">
              <span className="gi-stat-num" style={{ color: '#facc15' }}>{stats.nodesByType['Literal'] || 0}</span>
              <span className="gi-stat-label">Literal</span>
            </div>
            <div className="gi-stat-card">
              <span className="gi-stat-num" style={{ color: '#a78bfa' }}>{stats.inferredEdges.length}</span>
              <span className="gi-stat-label">추론 엣지</span>
            </div>
          </div>
        </section>

        {/* 노드 타입 분포 */}
        {nodes.length > 0 && (
          <section className="gi-section">
            <h3 className="gi-section-title">노드 타입 분포</h3>
            {Object.entries(stats.nodesByType).map(([type, count]) => (
              <div key={type} className="gi-bar-row">
                <span className="gi-bar-label">{type}</span>
                <div className="gi-bar-track">
                  <div
                    className={`gi-bar-fill gi-bar-fill--${type.toLowerCase()}`}
                    style={{ width: `${(count / nodes.length) * 100}%` }}
                  />
                </div>
                <span className="gi-bar-count">{count}</span>
              </div>
            ))}
          </section>
        )}

        {/* 관계 목록 */}
        {edges.length > 0 && (
          <section className="gi-section">
            <h3 className="gi-section-title">관계 유형</h3>
            <div className="gi-tag-list">
              {Object.entries(stats.edgesByLabel).map(([label, count]) => (
                <span key={label} className="gi-tag">{label} <b>{count}</b></span>
              ))}
            </div>
          </section>
        )}

        {/* 검증 이슈 */}
        <section className="gi-section">
          <h3 className="gi-section-title">검증 결과</h3>
          {issues.length === 0 ? (
            <div className="gi-ok">
              <CheckCircle size={14} /> 문제가 발견되지 않았습니다.
            </div>
          ) : (
            issues.map((issue, i) => (
              <div key={i} className="gi-issue">
                <div className="gi-issue-title">
                  <AlertTriangle size={12} /> {issue.title}
                </div>
                {issue.items.length > 0 && (
                  <div className="gi-issue-items">
                    {issue.items.map((item, j) => <span key={j} className="gi-chip">{item}</span>)}
                  </div>
                )}
              </div>
            ))
          )}
        </section>

        {/* 엔티티 표준화 */}
        <section className="gi-section">
          <h3 className="gi-section-title">엔티티 표준화</h3>
          <div className="gi-normalize-actions">
            <button className="gi-action-btn" onClick={handleDetectSimilar} disabled={nodes.length < 2}>
              <GitMerge size={12} /> 유사 노드 감지
            </button>
            <button className="gi-action-btn gi-action-btn--secondary" onClick={handleNormalizeLabels} disabled={nodes.length === 0}>
              Aa 레이블 정규화
            </button>
          </div>
          {normalizeMsg && <p className="gi-normalize-msg">{normalizeMsg}</p>}

          {mergeSuggestions !== null && (() => {
            const visible = mergeSuggestions.filter(s => !dismissed.has(s.id));
            if (visible.length === 0) {
              return <div className="gi-ok" style={{ marginTop: 8 }}><CheckCircle size={14} /> 유사 노드가 없습니다.</div>;
            }
            return (
              <div className="gi-merge-list">
                {visible.slice(0, 8).map(sug => (
                  <div key={sug.id} className="gi-merge-item">
                    <div className="gi-merge-labels">
                      <span className="gi-merge-node gi-merge-node--a">{sug.nodeA.label}</span>
                      <span className="gi-merge-arrow">≈</span>
                      <span className="gi-merge-node gi-merge-node--b">{sug.nodeB.label}</span>
                    </div>
                    <div className="gi-merge-meta">
                      <span className="gi-merge-reason">{sug.reason}</span>
                      <span className={`gi-merge-score${sug.score >= 0.9 ? ' gi-merge-score--high' : ''}`}>
                        {Math.round(sug.score * 100)}%
                      </span>
                    </div>
                    <div className="gi-merge-btns">
                      <button className="gi-merge-accept" onClick={() => handleAcceptMerge(sug)}>
                        ✓ 병합
                      </button>
                      <button className="gi-merge-reject" onClick={() => handleRejectMerge(sug.id)}>
                        × 건너뜀
                      </button>
                    </div>
                  </div>
                ))}
                {visible.length > 8 && (
                  <p className="gi-merge-more">+{visible.length - 8}개 더…</p>
                )}
              </div>
            );
          })()}
        </section>

        {/* AI 관계 자동화 */}
        {nodes.length >= 2 && (
          <section className="gi-section">
            <h3 className="gi-section-title">
              <Sparkles size={10} style={{ display: 'inline', marginRight: 4 }} />
              AI 관계 자동화
            </h3>

            {/* 자동 연결 */}
            <div className="gi-ai-auto-row">
              <div className="gi-ai-auto-info">
                <span className="gi-ai-auto-title">고립 노드 자동 연결</span>
                <span className="gi-ai-auto-desc">
                  {stats.isolated.length > 0
                    ? `고립 노드 ${stats.isolated.length}개를 AI가 분석해 연결 제안`
                    : `AI가 노드 간 누락된 관계를 탐색해 제안`}
                </span>
              </div>
              <button
                className="gi-ai-btn"
                disabled={!ollamaOnline || connRunning || nodes.length < 2}
                onClick={handleSuggestConnections}
              >
                {connRunning ? '분석 중...' : <><Sparkles size={10} /> 연결 제안</>}
              </button>
            </div>
            {connError && <p className="gi-ai-error"><AlertTriangle size={11}/> {connError}</p>}
            {connSuggestions !== null && (() => {
              const visible = connSuggestions.filter((_, i) => !dismissedConn.has(i))
                .filter(s => nodes.find(n => n.id === s.source) && nodes.find(n => n.id === s.target));
              if (visible.length === 0) return (
                <div className="gi-ok" style={{ marginTop: 6 }}><CheckCircle size={13} /> 제안할 연결이 없습니다.</div>
              );
              return (
                <div className="gi-merge-list">
                  {visible.map((s, idx) => {
                    const srcNode = nodes.find(n => n.id === s.source);
                    const tgtNode = nodes.find(n => n.id === s.target);
                    const origIdx = connSuggestions.indexOf(s);
                    return (
                      <div key={origIdx} className="gi-merge-item">
                        <div className="gi-merge-labels">
                          <span className="gi-merge-node gi-merge-node--a">{srcNode?.label}</span>
                          <span className="gi-merge-arrow">—[{s.label}]→</span>
                          <span className="gi-merge-node gi-merge-node--b">{tgtNode?.label}</span>
                        </div>
                        <div className="gi-merge-btns">
                          <button className="gi-merge-accept" onClick={() => handleAcceptConn(s, origIdx)}>✓ 추가</button>
                          <button className="gi-merge-reject" onClick={() => setDismissedConn(prev => new Set([...prev, origIdx]))}>× 건너뜀</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* 레이블 보완 */}
            <div className="gi-ai-auto-row" style={{ marginTop: 10 }}>
              <div className="gi-ai-auto-info">
                <span className="gi-ai-auto-title">엣지 레이블 AI 보완</span>
                <span className="gi-ai-auto-desc">
                  빈 레이블 또는 모든 관계에 AI가 의미 있는 레이블 제안
                </span>
              </div>
              <button
                className="gi-ai-btn"
                disabled={!ollamaOnline || labelRunning || edges.filter(e => !e.inferred).length === 0}
                onClick={handleSuggestLabels}
              >
                {labelRunning ? '분석 중...' : <><Sparkles size={10} /> 레이블 제안</>}
              </button>
            </div>
            {labelError && <p className="gi-ai-error"><AlertTriangle size={11}/> {labelError}</p>}
            {labelSuggestions !== null && (() => {
              const visible = labelSuggestions.filter(s => !dismissedLbl.has(s.id));
              if (visible.length === 0) return (
                <div className="gi-ok" style={{ marginTop: 6 }}><CheckCircle size={13} /> 보완할 레이블이 없습니다.</div>
              );
              return (
                <div className="gi-merge-list">
                  {visible.map(s => {
                    const edge = edges.find(e => e.id === s.id);
                    const srcNode = nodes.find(n => n.id === edge?.source);
                    const tgtNode = nodes.find(n => n.id === edge?.target);
                    return (
                      <div key={s.id} className="gi-merge-item">
                        <div className="gi-merge-labels">
                          <span className="gi-merge-node gi-merge-node--a">{srcNode?.label}</span>
                          <span className="gi-merge-arrow">→</span>
                          <span className="gi-merge-node gi-merge-node--b">{tgtNode?.label}</span>
                        </div>
                        <div className="gi-merge-meta">
                          <span className="gi-merge-reason">
                            {s.oldLabel ? `"${s.oldLabel}" → ` : ''}<b style={{ color: '#818cf8' }}>"{s.label}"</b>
                          </span>
                        </div>
                        <div className="gi-merge-btns">
                          <button className="gi-merge-accept" onClick={() => handleAcceptLabel(s)}>✓ 적용</button>
                          <button className="gi-merge-reject" onClick={() => setDismissedLbl(prev => new Set([...prev, s.id]))}>× 건너뜀</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </section>
        )}

        {/* 그래프 분석 */}
        {nodes.length > 1 && (
          <section className="gi-section">
            <h3 className="gi-section-title">
              <Activity size={10} style={{ display: 'inline', marginRight: 4 }} />
              그래프 분석
            </h3>

            {/* 중심성 */}
            <p className="gi-analysis-sub">연결 중심성 (상위 8)</p>
            <div className="gi-centrality-list">
              {centrality.map((n, i) => (
                <div key={n.id} className="gi-cent-row">
                  <span className="gi-cent-rank">{i + 1}</span>
                  <span className="gi-cent-label" title={n.label}>{n.label}</span>
                  <span className="gi-cent-type" style={{ color: n.type === 'Class' ? '#60a5fa' : n.type === 'Instance' ? '#4ade80' : '#facc15' }}>{n.type}</span>
                  <span className="gi-cent-deg">{n.degree}</span>
                </div>
              ))}
            </div>

            {/* 경로 탐색 */}
            <p className="gi-analysis-sub" style={{ marginTop: 10 }}>최단 경로 탐색</p>
            <div className="gi-path-row">
              <select className="gi-select" value={pathSrcId} onChange={e => setPathSrcId(e.target.value)}>
                <option value="">출발 노드</option>
                {nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
              </select>
              <span className="gi-path-arrow">→</span>
              <select className="gi-select" value={pathTgtId} onChange={e => setPathTgtId(e.target.value)}>
                <option value="">도착 노드</option>
                {nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
              </select>
              <button className="gi-action-btn" style={{ marginLeft: 'auto' }} onClick={handleFindPath} disabled={!pathSrcId || !pathTgtId}>탐색</button>
            </div>
            {pathResult !== null && (
              pathResult
                ? <div className="gi-path-result">
                    {pathResult.map((id, i) => {
                      const n = nodes.find(x => x.id === id);
                      return <React.Fragment key={id}>
                        {i > 0 && <span className="gi-path-sep">→</span>}
                        <span className="gi-chip">{n?.label ?? id}</span>
                      </React.Fragment>;
                    })}
                    <span className="gi-path-len">({pathResult.length - 1}홉)</span>
                  </div>
                : <p className="gi-path-none">경로가 없습니다.</p>
            )}

            {/* N-hop 서브그래프 */}
            <p className="gi-analysis-sub" style={{ marginTop: 10 }}>N-hop 서브그래프</p>
            <div className="gi-path-row">
              <select className="gi-select" style={{ flex: 1 }} value={hopCenter} onChange={e => setHopCenter(e.target.value)}>
                <option value="">중심 노드</option>
                {nodes.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
              </select>
              <select className="gi-select" style={{ width: 60 }} value={hopN} onChange={e => setHopN(Number(e.target.value))}>
                {[1, 2, 3, 4].map(v => <option key={v} value={v}>{v}홉</option>)}
              </select>
              <button className="gi-action-btn" onClick={handleHopSubgraph} disabled={!hopCenter}>강조</button>
            </div>

            {(pathResult !== null || (nodes.length > 0 && state.highlightedIds.length > 0)) && (
              <button className="gi-action-btn gi-action-btn--secondary" style={{ marginTop: 6 }} onClick={handleClearAnalysis}>
                강조 해제
              </button>
            )}
          </section>
        )}

        {/* 버전 스냅샷 */}
        <section className="gi-section">
          <h3 className="gi-section-title"><Camera size={10} style={{ display: 'inline', marginRight: 4 }} />버전 스냅샷</h3>
          <div className="gi-snap-row">
            <input
              className="gi-snap-input"
              placeholder="스냅샷 이름 (선택)"
              value={snapName}
              onChange={e => setSnapName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleTakeSnapshot(); }}
            />
            <button className="gi-action-btn" onClick={handleTakeSnapshot} disabled={nodes.length === 0}>
              <Camera size={11} /> 저장
            </button>
          </div>
          {state.snapshots.length === 0 ? (
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)', marginTop: 6 }}>저장된 스냅샷이 없습니다.</p>
          ) : (
            <div className="gi-snap-list">
              {[...state.snapshots].reverse().map(snap => (
                <div key={snap.id} className="gi-snap-item">
                  <div className="gi-snap-info">
                    <span className="gi-snap-name">{snap.name}</span>
                    <span className="gi-snap-meta">{snap.nodes.length}N · {snap.edges.length}E</span>
                  </div>
                  <div className="gi-snap-btns">
                    <button className="gi-merge-accept" title="복원" onClick={() => dispatch({ type: 'RESTORE_SNAPSHOT', payload: snap.id })}>
                      <RotateCcw size={11} />
                    </button>
                    <button className="gi-merge-reject" title="삭제" onClick={() => dispatch({ type: 'DELETE_SNAPSHOT', payload: snap.id })}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 정보성 메모 */}
        {infos.length > 0 && (
          <section className="gi-section">
            <h3 className="gi-section-title">참고 사항</h3>
            {infos.map((info, i) => (
              <div key={i} className="gi-info">
                <div className="gi-issue-title">
                  <Info size={12} /> {info.title}
                  {info.isNoDesc && (
                    <button
                      className="gi-ai-btn"
                      disabled={!ollamaOnline || !!descProgress}
                      onClick={handleFillDescriptions}
                      title={ollamaOnline ? 'AI로 설명 일괄 생성' : 'Ollama 오프라인'}
                    >
                      {descProgress
                        ? `${descProgress.current}/${descProgress.total} 처리 중...`
                        : <><Sparkles size={10} /> AI 일괄 생성</>
                      }
                    </button>
                  )}
                </div>
                {info.items.length > 0 && (
                  <div className="gi-issue-items">
                    {info.items.map((item, j) => <span key={j} className="gi-chip">{item}</span>)}
                    {stats.noDesc.length > 8 && info.isNoDesc && (
                      <span className="gi-chip gi-chip--muted">+{stats.noDesc.length - 8}개 더</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

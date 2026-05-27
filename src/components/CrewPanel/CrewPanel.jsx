import React, { useState, useEffect } from 'react';
import { X, Zap, CheckCircle, AlertCircle, RefreshCw, Brain, GitBranch, BookOpen, Trash2, Plus } from 'lucide-react';
import { useCrewAI } from '../../hooks/useCrewAI';
import './CrewPanel.css';

const STATUS_COLORS = {
  pending:   'rgba(255,255,255,0.2)',
  running:   '#818cf8',
  done:      '#4ade80',
  error:     '#f87171',
  completed: '#4ade80',
  failed:    '#f87171',
};

export default function CrewPanel({ onClose, initialTopic = '' }) {
  const {
    agents, jobStatus, backendOnline, error, result,
    schemaEvolution, memoryApplied, memoryPatterns,
    startJob, reset, checkBackend,
    fetchMemoryPatterns, saveMemoryPattern, deleteMemoryPattern,
    totalAgents,
  } = useCrewAI();

  const [topic, setTopic]         = useState(initialTopic);
  const [maxNodes, setMaxNodes]   = useState(25);
  const [depth, setDepth]         = useState('medium');
  const [language, setLanguage]   = useState('Korean');
  const [expandedIdx, setExpandedIdx] = useState(null);

  // Memory panel state
  const [showMemory, setShowMemory] = useState(false);
  const [newPattern, setNewPattern] = useState({ original: '', corrected: '', note: '' });
  const [savingPattern, setSavingPattern] = useState(false);

  useEffect(() => {
    checkBackend();
    fetchMemoryPatterns();
  }, [checkBackend, fetchMemoryPatterns]);

  const handleStart = async () => {
    if (!topic.trim()) return;
    await startJob(topic.trim(), { max_nodes: maxNodes, depth, language });
  };

  const handleSavePattern = async () => {
    if (!newPattern.original.trim() || !newPattern.corrected.trim()) return;
    setSavingPattern(true);
    await saveMemoryPattern(topic.trim() || '일반', newPattern.original, newPattern.corrected, newPattern.note);
    setNewPattern({ original: '', corrected: '', note: '' });
    setSavingPattern(false);
  };

  const isRunning   = jobStatus === 'running';
  const isDone      = jobStatus === 'completed';
  const isFailed    = jobStatus === 'failed';
  const isIdle      = jobStatus === 'idle';
  const completedN  = agents.filter(a => a.status === 'done').length;

  return (
    <div className="crew-overlay" onClick={onClose}>
      <div className="crew-modal glass" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="crew-header">
          <div className="crew-header-left">
            <span className="crew-title">CrewAI 온톨로지 생성</span>
            {backendOnline !== null && (
              <span className={`crew-badge ${backendOnline ? 'crew-badge--online' : 'crew-badge--offline'}`}>
                {backendOnline ? '● 백엔드 연결됨' : '● 백엔드 오프라인'}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              className={`crew-mem-toggle${showMemory ? ' crew-mem-toggle--active' : ''}`}
              onClick={() => setShowMemory(v => !v)}
              title="장기 기억 패턴 관리"
            >
              <Brain size={13} />
              <span>기억 {memoryPatterns.length > 0 ? `(${memoryPatterns.length})` : ''}</span>
            </button>
            <button className="crew-close" onClick={onClose}><X size={15} /></button>
          </div>
        </div>

        {/* Memory Panel */}
        {showMemory && (
          <div className="crew-memory-panel">
            <div className="crew-memory-title">
              <Brain size={12} /> 에이전트 장기 기억 — 관계 수정 패턴
            </div>

            {memoryPatterns.length === 0 ? (
              <p className="crew-memory-empty">저장된 패턴이 없습니다.<br />아래에서 새 패턴을 추가하세요.</p>
            ) : (
              <div className="crew-memory-list">
                {memoryPatterns.map(p => (
                  <div key={p.id} className="crew-memory-item">
                    <div className="crew-memory-item-main">
                      <span className="crew-memory-domain">[{p.domain}]</span>
                      <span className="crew-memory-relation">
                        <span className="crew-memory-from">{p.original}</span>
                        <span className="crew-memory-arrow">→</span>
                        <span className="crew-memory-to">{p.corrected}</span>
                      </span>
                      <span className="crew-memory-count">{p.count}회</span>
                    </div>
                    {p.note && <div className="crew-memory-note">{p.note}</div>}
                    <button className="crew-memory-del" onClick={() => deleteMemoryPattern(p.id)}>
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="crew-memory-add">
              <input
                className="crew-input crew-input--sm"
                placeholder="기존 관계 (예: is-a)"
                value={newPattern.original}
                onChange={e => setNewPattern(p => ({ ...p, original: e.target.value }))}
              />
              <span className="crew-memory-arrow-lg">→</span>
              <input
                className="crew-input crew-input--sm"
                placeholder="수정할 관계 (예: inherits-from)"
                value={newPattern.corrected}
                onChange={e => setNewPattern(p => ({ ...p, corrected: e.target.value }))}
              />
              <input
                className="crew-input crew-input--sm"
                placeholder="메모 (선택)"
                value={newPattern.note}
                onChange={e => setNewPattern(p => ({ ...p, note: e.target.value }))}
              />
              <button
                className="crew-mem-add-btn"
                disabled={!newPattern.original.trim() || !newPattern.corrected.trim() || savingPattern}
                onClick={handleSavePattern}
              >
                <Plus size={12} /> 저장
              </button>
            </div>
          </div>
        )}

        {/* Topic input */}
        {isIdle && (
          <div className="crew-body">
            {memoryPatterns.length > 0 && (
              <div className="crew-memory-hint">
                <Brain size={11} />
                <span>{memoryPatterns.length}개의 관계 수정 패턴이 이번 생성에 자동 적용됩니다.</span>
              </div>
            )}

            <div className="crew-section">
              <label className="crew-label">분석 주제</label>
              <input
                className="crew-input"
                placeholder="예: 조선왕조 왕들의 계보, 태양계 행성, 한국 역대 대통령..."
                value={topic}
                onChange={e => setTopic(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && backendOnline) handleStart(); }}
                autoFocus
              />
            </div>
            <div className="crew-options">
              <div className="crew-opt">
                <label className="crew-opt-label">최대 노드</label>
                <select className="crew-select" value={maxNodes} onChange={e => setMaxNodes(Number(e.target.value))}>
                  {[15, 25, 40, 60, 80, 100, 150, 200].map(v => <option key={v} value={v}>{v}개</option>)}
                </select>
              </div>
              <div className="crew-opt">
                <label className="crew-opt-label">검색 깊이</label>
                <select className="crew-select" value={depth} onChange={e => setDepth(e.target.value)}>
                  <option value="shallow">얕게</option>
                  <option value="medium">보통</option>
                  <option value="deep">깊게</option>
                </select>
              </div>
              <div className="crew-opt">
                <label className="crew-opt-label">언어</label>
                <select className="crew-select" value={language} onChange={e => setLanguage(e.target.value)}>
                  <option value="Korean">한국어</option>
                  <option value="English">영어</option>
                </select>
              </div>
            </div>
            {!backendOnline && (
              <p className="crew-warn">
                FastAPI 백엔드가 오프라인입니다.<br />
                <code>cd backend && uvicorn main:app --reload</code> 로 서버를 시작하세요.
              </p>
            )}
            <button
              className="crew-start-btn"
              disabled={!topic.trim() || !backendOnline}
              onClick={handleStart}
            >
              <Zap size={14} /> CrewAI 파이프라인 시작
            </button>
          </div>
        )}

        {/* Progress */}
        {(isRunning || isDone || isFailed) && (
          <div className="crew-body">
            <div className="crew-progress-header">
              <span className="crew-progress-label">
                {isDone ? '완료' : isFailed ? '오류 발생' : `처리 중 ${completedN}/${totalAgents}`}
              </span>
              <span className="crew-progress-pct">{Math.round((completedN / totalAgents) * 100)}%</span>
            </div>
            <div className="crew-progress-bar">
              <div className="crew-progress-fill" style={{ width: `${(completedN / totalAgents) * 100}%` }} />
            </div>

            <div className="crew-agents">
              {agents.map((agent, i) => (
                <div
                  key={i}
                  className={`crew-agent${expandedIdx === i ? ' crew-agent--open' : ''}${agent.name === 'Critic Agent' ? ' crew-agent--critic' : ''}`}
                  onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
                >
                  <div className="crew-agent-row">
                    <span className="crew-agent-emoji">{agent.emoji}</span>
                    <div className="crew-agent-info">
                      <span className="crew-agent-name">{agent.name}</span>
                      <span className="crew-agent-msg" style={{ color: STATUS_COLORS[agent.status] }}>
                        {agent.message || agent.status}
                      </span>
                    </div>
                    <div className="crew-agent-status-dot" style={{ background: STATUS_COLORS[agent.status] }}>
                      {agent.status === 'running' && <div className="crew-spin" />}
                    </div>
                  </div>
                  {expandedIdx === i && agent.preview && (
                    <div className="crew-agent-preview">{agent.preview}</div>
                  )}
                </div>
              ))}
            </div>

            {error && (
              <div className="crew-error">
                <AlertCircle size={13} /> {error}
              </div>
            )}

            {/* Schema Evolution suggestions */}
            {isDone && schemaEvolution.length > 0 && (
              <div className="crew-schema-evolution">
                <div className="crew-schema-title">
                  <GitBranch size={12} /> 동적 스키마 제안 ({schemaEvolution.length}건)
                </div>
                {schemaEvolution.map((s, i) => (
                  <div key={i} className="crew-schema-item">
                    <span className="crew-schema-type">{s.type}</span>
                    <span className="crew-schema-rationale">{s.rationale}</span>
                    {s.example_nodes?.length > 0 && (
                      <span className="crew-schema-examples">예: {s.example_nodes.slice(0, 3).join(', ')}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Memory patterns applied */}
            {isDone && memoryApplied.length > 0 && (
              <div className="crew-memory-applied">
                <div className="crew-memory-applied-title">
                  <BookOpen size={12} /> 적용된 기억 패턴 ({memoryApplied.length}건)
                </div>
                {memoryApplied.map((p, i) => (
                  <div key={i} className="crew-memory-applied-item">
                    <span className="crew-memory-from">{p.original}</span>
                    <span className="crew-memory-arrow">→</span>
                    <span className="crew-memory-to">{p.corrected}</span>
                  </div>
                ))}
              </div>
            )}

            {isDone && result && (
              <div className="crew-result-summary">
                <CheckCircle size={13} />
                캔버스에 적용됨 — {result.nodes?.length || 0}개 노드, {result.edges?.length || 0}개 엣지
              </div>
            )}

            <div className="crew-footer-btns">
              <button className="crew-reset-btn" onClick={reset}>
                <RefreshCw size={12} /> 초기화
              </button>
              {isDone && (
                <button className="crew-close-btn-main" onClick={onClose}>
                  확인
                </button>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

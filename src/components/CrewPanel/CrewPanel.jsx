import React, { useState, useEffect } from 'react';
import { X, Zap, CheckCircle, AlertCircle, RefreshCw, Download } from 'lucide-react';
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
  const { agents, jobStatus, backendOnline, error, result, startJob, reset, checkBackend } = useCrewAI();
  const [topic, setTopic]         = useState(initialTopic);
  const [maxNodes, setMaxNodes]   = useState(25);
  const [depth, setDepth]         = useState('medium');
  const [language, setLanguage]   = useState('Korean');
  const [expandedIdx, setExpandedIdx] = useState(null);

  useEffect(() => { checkBackend(); }, [checkBackend]);

  const handleStart = async () => {
    if (!topic.trim()) return;
    await startJob(topic.trim(), { max_nodes: maxNodes, depth, language });
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
          <button className="crew-close" onClick={onClose}><X size={15} /></button>
        </div>

        {/* Topic input */}
        {isIdle && (
          <div className="crew-body">
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
            {/* Overall progress bar */}
            <div className="crew-progress-header">
              <span className="crew-progress-label">
                {isDone ? '완료' : isFailed ? '오류 발생' : `처리 중 ${completedN}/5`}
              </span>
              <span className="crew-progress-pct">{Math.round((completedN / 5) * 100)}%</span>
            </div>
            <div className="crew-progress-bar">
              <div className="crew-progress-fill" style={{ width: `${(completedN / 5) * 100}%` }} />
            </div>

            {/* Agent list */}
            <div className="crew-agents">
              {agents.map((agent, i) => (
                <div
                  key={i}
                  className={`crew-agent${expandedIdx === i ? ' crew-agent--open' : ''}`}
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

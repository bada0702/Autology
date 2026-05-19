import React, { useContext, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import {
  Upload, FileText, MessageSquare, Layers, Zap, Users, Database,
  ChevronDown, ChevronRight, X, ShieldCheck
} from 'lucide-react';
import WorkflowContext from '../../context/WorkflowContext';
import GraphContext from '../../context/GraphContext';
import { useOllama } from '../../hooks/useOllama';
import { parseFile, isCSVLike, parseCSVToGraph } from '../../utils/fileParser';
import { chunkText, estimateChunks, chunkByRows } from '../../utils/chunker';
import { mergeGraphs } from '../../utils/merger';
import CrewPanel from '../CrewPanel/CrewPanel';
import GraphInspector from '../Inspector/GraphInspector';
import './WorkflowPanel.css';

// ── File Upload Zone ──────────────────────────────────────────────────────────
function FileUploadZone({ onParsed }) {
  const inputRef = useRef();
  const [dragging, setDragging] = useState(false);
  const [status, setStatus]     = useState(null);
  const [error, setError]       = useState(null);

  const handle = async (file) => {
    if (!file) return;
    setError(null);
    setStatus('loading');
    try {
      const text = await parseFile(file);
      setStatus({ name: file.name });
      onParsed(text, file.name);
    } catch (e) {
      setError(e.message);
      setStatus(null);
    }
  };

  return (
    <div
      className={`wf-dropzone${dragging ? ' wf-dropzone--over' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); handle(e.dataTransfer.files[0]); }}
      onClick={() => inputRef.current.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".txt,.md,.csv,.xlsx,.xls,.ods"
        style={{ display: 'none' }}
        onChange={e => handle(e.target.files[0])}
      />
      {status === 'loading' ? (
        <span className="wf-dropzone-hint">파싱 중...</span>
      ) : status ? (
        <div className="wf-file-info"><FileText size={13} /><span className="wf-file-name">{status.name}</span></div>
      ) : (
        <>
          <Upload size={16} className="wf-dropzone-icon" />
          <span className="wf-dropzone-hint">클릭하거나 파일을 끌어다 놓으세요</span>
          <span className="wf-dropzone-types">txt · csv · xlsx · xls</span>
        </>
      )}
      {error && <span className="wf-dropzone-error">{error}</span>}
    </div>
  );
}

// ── DataGenModal ──────────────────────────────────────────────────────────────
function DataGenModal({ wfState, wfDispatch, onClose }) {
  const { state: graphState, dispatch: graphDispatch } = useContext(GraphContext);
  const { generateGraph, extractGraphFromChunk, isGenerating, ollamaOnline } = useOllama();
  const [pipelineState, setPipelineState] = useState(null);

  const problem = wfState.data.problemDefinition || '';
  const rawData = wfState.data.rawData || '';

  const handleGenerate = async () => {
    const context = [problem, rawData].filter(Boolean).join('\n\n');
    if (!context) return;
    if (isCSVLike(rawData)) {
      setPipelineState({ current: 1, total: 1, done: false, errors: 0 });
      graphDispatch({ type: 'LOAD_GRAPH', payload: parseCSVToGraph(rawData) });
      setPipelineState(s => ({ ...s, done: true }));
      return;
    }
    if (!ollamaOnline) return;
    const rawLines = rawData.trim().split('\n').filter(l => l.trim()).length;
    const chunks   = rawLines > 10 ? chunkByRows(rawData) : chunkText(context);
    if (chunks.length === 1) { await generateGraph(context); return; }
    setPipelineState({ current: 0, total: chunks.length, done: false, errors: 0 });
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      setPipelineState(s => ({ ...s, current: i + 1 }));
      try { const g = await extractGraphFromChunk(chunks[i]); if (g) parts.push(g); }
      catch { setPipelineState(s => ({ ...s, errors: s.errors + 1 })); }
    }
    if (parts.length > 0) graphDispatch({ type: 'LOAD_GRAPH', payload: mergeGraphs(parts) });
    setPipelineState(s => ({ ...s, done: true }));
  };

  const isRunning = pipelineState && !pipelineState.done && pipelineState.current > 0;

  return ReactDOM.createPortal(
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal glass" onClick={e => e.stopPropagation()}>
        <div className="wf-modal-hd">
          <Database size={15} />
          <span>데이터 생성</span>
          <button className="wf-modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="wf-modal-body">
          <label className="wf-content-label">분석 주제 (선택)</label>
          <textarea
            className="wf-textarea wf-textarea--sm"
            placeholder="어떤 도메인을 분석하나요?"
            value={problem}
            onChange={e => wfDispatch({ type: 'UPDATE_DATA', payload: { problemDefinition: e.target.value } })}
          />
          <label className="wf-content-label">파일 업로드</label>
          <FileUploadZone
            onParsed={(text, name) => wfDispatch({ type: 'UPDATE_DATA', payload: { rawData: text, fileName: name } })}
          />
          {rawData ? (
            <>
              <label className="wf-content-label">파싱된 내용</label>
              <textarea
                className="wf-textarea wf-textarea--sm"
                value={rawData}
                onChange={e => wfDispatch({ type: 'UPDATE_DATA', payload: { rawData: e.target.value } })}
              />
              {estimateChunks(rawData) > 1 && (
                <div className="wf-chunk-info">
                  <Layers size={11} />
                  <span>{estimateChunks(rawData)}개 청크로 분할 처리됩니다</span>
                </div>
              )}
            </>
          ) : (
            <>
              <label className="wf-content-label">또는 직접 입력</label>
              <textarea
                className="wf-textarea"
                placeholder="텍스트를 직접 붙여넣으세요..."
                value={rawData}
                onChange={e => wfDispatch({ type: 'UPDATE_DATA', payload: { rawData: e.target.value } })}
              />
            </>
          )}
          <button
            className="wf-ai-btn"
            disabled={isGenerating || isRunning || !rawData || !ollamaOnline}
            onClick={handleGenerate}
          >
            {isRunning
              ? `처리 중 ${pipelineState.current}/${pipelineState.total}…`
              : isGenerating ? '생성 중…'
              : 'AI로 그래프 생성'}
          </button>
          {pipelineState && !pipelineState.done && pipelineState.total > 1 && (
            <div className="wf-pipeline-bar">
              <div className="wf-pipeline-fill" style={{ width: `${(pipelineState.current / pipelineState.total) * 100}%` }} />
            </div>
          )}
          {pipelineState?.done && (
            <p className="wf-pipeline-done">
              ✓ 완료 — {graphState.nodes.length}개 노드{pipelineState.errors > 0 && ` (오류 ${pipelineState.errors}개)`}
            </p>
          )}
          {!ollamaOnline && <p className="wf-warn-text">Ollama 연결 안됨</p>}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── QuickGenModal ─────────────────────────────────────────────────────────────
function QuickGenModal({ wfState, wfDispatch, onClose }) {
  const { generateGraph, isGenerating, ollamaOnline } = useOllama();
  const problem = wfState.data.problemDefinition || '';
  const goals   = wfState.data.goals || '';

  const handleGenerate = async () => {
    const prompt = [
      problem && `[분석 주제]\n${problem}`,
      goals   && `[목표 및 활용]\n${goals}`,
    ].filter(Boolean).join('\n\n');
    if (!prompt) return;
    await generateGraph(prompt);
  };

  return ReactDOM.createPortal(
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal glass" onClick={e => e.stopPropagation()}>
        <div className="wf-modal-hd">
          <Zap size={15} />
          <span>빠른 생성</span>
          <button className="wf-modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="wf-modal-body">
          <p className="wf-content-hint">
            문제 정의와 목표를 기반으로 AI가 직접 지식 그래프를 생성합니다.
          </p>
          <label className="wf-content-label">문제 정의</label>
          <textarea
            className="wf-textarea wf-textarea--sm"
            placeholder="어떤 도메인을, 왜 분석하나요?&#10;예) 해군 함정 종류와 임무를 온톨로지로 정리한다."
            value={problem}
            onChange={e => wfDispatch({ type: 'UPDATE_DATA', payload: { problemDefinition: e.target.value } })}
            autoFocus
          />
          <label className="wf-content-label">목표 설정</label>
          <textarea
            className="wf-textarea wf-textarea--sm"
            placeholder="어떻게 활용할 건가요?&#10;예) 함종별 무장·속도·역할을 비교 탐색한다."
            value={goals}
            onChange={e => wfDispatch({ type: 'UPDATE_DATA', payload: { goals: e.target.value } })}
          />
          <button
            className="wf-ai-btn"
            disabled={isGenerating || !ollamaOnline || (!problem && !goals)}
            onClick={handleGenerate}
          >
            {isGenerating ? '생성 중…' : '⚡ AI 빠른 생성'}
          </button>
          {!problem && !goals && (
            <p className="wf-warn-text">문제 정의 또는 목표 설정을 먼저 입력하세요.</p>
          )}
          {!ollamaOnline && <p className="wf-warn-text">Ollama 연결 안됨</p>}
          {isGenerating && (
            <div className="wf-pipeline-bar">
              <div className="wf-pipeline-fill" style={{ width: '100%', animation: 'wf-pulse 1.2s ease-in-out infinite' }} />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── CrewGenModal ──────────────────────────────────────────────────────────────
function CrewGenModal({ wfState, wfDispatch, onClose, onStart }) {
  const problem = wfState.data.problemDefinition || '';
  const goals   = wfState.data.goals || '';
  const topic   = [problem, goals].filter(Boolean).join('\n\n');

  return ReactDOM.createPortal(
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal glass" onClick={e => e.stopPropagation()}>
        <div className="wf-modal-hd">
          <Users size={15} />
          <span>CrewAI 생성</span>
          <button className="wf-modal-close" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="wf-modal-body">
          <p className="wf-content-hint">
            5-에이전트 파이프라인이 웹 리서치부터 온톨로지 편집까지 자동 수행합니다.<br />
            문제 정의와 목표가 분석 주제로 전달됩니다.
          </p>
          <label className="wf-content-label">문제 정의</label>
          <textarea
            className="wf-textarea wf-textarea--sm"
            placeholder="어떤 도메인을, 왜 분석하나요?&#10;예) 해군 함정 종류와 임무를 온톨로지로 정리한다."
            value={problem}
            onChange={e => wfDispatch({ type: 'UPDATE_DATA', payload: { problemDefinition: e.target.value } })}
            autoFocus
          />
          <label className="wf-content-label">목표 설정</label>
          <textarea
            className="wf-textarea wf-textarea--sm"
            placeholder="어떻게 활용할 건가요?&#10;예) 함종별 무장·속도·역할을 비교 탐색한다."
            value={goals}
            onChange={e => wfDispatch({ type: 'UPDATE_DATA', payload: { goals: e.target.value } })}
          />
          {topic && (
            <div className="wf-crew-preview">
              <span className="wf-crew-preview-label">전달될 주제</span>
              <span className="wf-crew-preview-text">
                {topic.slice(0, 140)}{topic.length > 140 ? '…' : ''}
              </span>
            </div>
          )}
          <button
            className="wf-ai-btn wf-ai-btn--crew"
            disabled={!topic}
            onClick={onStart}
          >
            <Users size={12} /> CrewAI 파이프라인 시작
          </button>
          {!topic && <p className="wf-warn-text">문제 정의 또는 목표 설정을 먼저 입력하세요.</p>}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────
export default function WorkflowPanel({ onOpenChat }) {
  const { state, dispatch }       = useContext(WorkflowContext);
  const { state: graphState }     = useContext(GraphContext);
  const [showDataGen, setShowDataGen]     = useState(false);
  const [showQuickGen, setShowQuickGen]   = useState(false);
  const [showCrewGen, setShowCrewGen]     = useState(false);
  const [showCrew, setShowCrew]           = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const [expandedStep, setExpandedStep]   = useState(null);

  const crewTopic = [state.data.problemDefinition, state.data.goals]
    .filter(Boolean).join('\n\n');
  const toggle = (n) => setExpandedStep(prev => prev === n ? null : n);

  const handleCrewStart = () => {
    setShowCrewGen(false);
    setShowCrew(true);
  };

  return (
    <aside className="wf-panel glass">
      <div className="wf-header">
        <span className="wf-title">워크플로우</span>
        <span className="wf-badge">{graphState.nodes.length}N · {graphState.edges.length}E</span>
      </div>

      <div className="wf-nav">

        {/* ── 1. 지식그래프 생성 ── */}
        <div className="wf-nav-section">
          <div className="wf-nav-hd">
            <span className="wf-nav-num">1</span>
            <span className="wf-nav-title">지식그래프 생성</span>
          </div>
          <div className="wf-nav-sub">
            <button className="wf-nav-sub-btn" onClick={() => setShowDataGen(true)}>
              <Database size={12} /> 데이터 생성
            </button>
            <button className="wf-nav-sub-btn" onClick={() => setShowQuickGen(true)}>
              <Zap size={12} /> 빠른 생성
            </button>
            <button className="wf-nav-sub-btn" onClick={() => setShowCrewGen(true)}>
              <Users size={12} /> CrewAI 생성
            </button>
          </div>
        </div>

        {/* ── 2. 엔티티 추출 ── */}
        <div className="wf-nav-section">
          <button
            className={`wf-nav-hd wf-nav-hd--btn${expandedStep === 2 ? ' wf-nav-hd--open' : ''}`}
            onClick={() => toggle(2)}
          >
            <span className="wf-nav-num">2</span>
            <span className="wf-nav-title">엔티티 추출</span>
            {expandedStep === 2
              ? <ChevronDown size={11} className="wf-nav-chevron" />
              : <ChevronRight size={11} className="wf-nav-chevron" />}
          </button>
          {expandedStep === 2 && (
            <div className="wf-nav-body">
              <div className="wf-stats-row">
                <span className="wf-stat" style={{ color: '#60a5fa' }}>
                  {graphState.nodes.filter(n => n.type === 'Class').length} Class
                </span>
                <span className="wf-stat" style={{ color: '#4ade80' }}>
                  {graphState.nodes.filter(n => n.type === 'Instance').length} Inst
                </span>
                <span className="wf-stat" style={{ color: '#facc15' }}>
                  {graphState.nodes.filter(n => n.type === 'Literal').length} Lit
                </span>
              </div>
              <ul className="wf-hint-list">
                <li>노드 클릭 → 우측 패널에서 타입 변경</li>
                <li>Delete 키로 불필요 노드 제거</li>
              </ul>
            </div>
          )}
        </div>

        {/* ── 3. 관계 모델링 ── */}
        <div className="wf-nav-section">
          <button
            className={`wf-nav-hd wf-nav-hd--btn${expandedStep === 3 ? ' wf-nav-hd--open' : ''}`}
            onClick={() => toggle(3)}
          >
            <span className="wf-nav-num">3</span>
            <span className="wf-nav-title">관계 모델링</span>
            {expandedStep === 3
              ? <ChevronDown size={11} className="wf-nav-chevron" />
              : <ChevronRight size={11} className="wf-nav-chevron" />}
          </button>
          {expandedStep === 3 && (
            <div className="wf-nav-body">
              <ul className="wf-hint-list">
                <li>더블클릭 — 노드 추가</li>
                <li>노드 포트 드래그 — 연결</li>
                <li>엣지 클릭 → 레이블 편집</li>
                <li>Delete — 선택 삭제</li>
              </ul>
              <div className="wf-stats-row">
                <span className="wf-stat">{graphState.nodes.length} 노드</span>
                <span className="wf-stat">{graphState.edges.length} 엣지</span>
              </div>
            </div>
          )}
        </div>

        {/* ── 4. 검증 ── */}
        <div className="wf-nav-section">
          <button className="wf-nav-hd wf-nav-hd--btn" onClick={() => setShowInspector(true)}>
            <span className="wf-nav-num">4</span>
            <span className="wf-nav-title">검증</span>
            <ShieldCheck size={12} className="wf-nav-chevron" />
          </button>
        </div>

        {/* ── 5. 지식그래프 테스트 ── */}
        <div className="wf-nav-section">
          <button className="wf-nav-hd wf-nav-hd--btn" onClick={onOpenChat}>
            <span className="wf-nav-num">5</span>
            <span className="wf-nav-title">지식그래프 테스트</span>
            <MessageSquare size={12} className="wf-nav-chevron" />
          </button>
        </div>

      </div>

      {/* ── Modals ── */}
      {showDataGen  && <DataGenModal  wfState={state} wfDispatch={dispatch} onClose={() => setShowDataGen(false)} />}
      {showQuickGen && <QuickGenModal wfState={state} wfDispatch={dispatch} onClose={() => setShowQuickGen(false)} />}
      {showCrewGen  && <CrewGenModal  wfState={state} wfDispatch={dispatch} onClose={() => setShowCrewGen(false)} onStart={handleCrewStart} />}
      {showCrew && ReactDOM.createPortal(
        <CrewPanel onClose={() => setShowCrew(false)} initialTopic={crewTopic} />,
        document.body
      )}
      {showInspector && ReactDOM.createPortal(
        <GraphInspector onClose={() => setShowInspector(false)} />,
        document.body
      )}
    </aside>
  );
}

import React, { useContext, useState, useRef } from 'react';
import ReactDOM from 'react-dom';
import {
  MousePointer2, Hand, PlusCircle, Trash2, Undo2, Redo2,
  Save, FolderOpen, FilePlus2, Wifi, WifiOff, ChevronDown, X,
  MessageSquare, LayoutGrid, Download, Search, Users, FolderPlus,
  BarChart2, Database, Link2
} from 'lucide-react';
import { searchNodes } from '../../utils/graphAnalysis';
import { hierarchicalLayout, radialLayout, forceLayout } from '../../utils/layout';
import { saveMermaid, saveMarkdown, saveCypher, saveSVG, savePNG } from '../../utils/exporters';
import { exportToTurtle, exportToOWL, parseOWL, parseTurtle } from '../../utils/ontologyIO';
import { exportWithRDFLib, importWithRDFLib } from '../../utils/semanticApi';
import GraphContext from '../../context/GraphContext';
import LLMContext from '../../context/LLMContext';
import RuleContext from '../../context/RuleContext';
import CrewPanel from '../CrewPanel/CrewPanel';
import GraphEvaluator from '../Evaluator/GraphEvaluator';
import SemanticWorkbench from '../SemanticWorkbench/SemanticWorkbench';
import './Toolbar.css';

export default function Toolbar({ onOpenChat }) {
  const { state, dispatch }  = useContext(GraphContext);
  const { state: llm, dispatch: llmDispatch, checkConnection } = useContext(LLMContext);
  const { state: ruleState, dispatch: ruleDispatch } = useContext(RuleContext);
  const [showLayout, setShowLayout]       = useState(false);
  const [showExport, setShowExport]       = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showMerge, setShowMerge]         = useState(false);
  const [showEvaluator, setShowEvaluator] = useState(false);
  const [showSemantic, setShowSemantic]   = useState(false);
  const [modelMenuRect, setModelMenuRect] = useState(null);
  const [layoutMenuRect, setLayoutMenuRect] = useState(null);
  const [exportMenuRect, setExportMenuRect] = useState(null);
  const [mergeMenuRect, setMergeMenuRect]   = useState(null);
  const [searchQuery, setSearchQuery]       = useState('');
  const [urlInput, setUrlInput]             = useState('');
  const [connecting, setConnecting]         = useState(false);
  const [pendingMergeFormat, setPendingMergeFormat] = useState(null);
  const fileRef       = useRef(null);
  const mergeFileRef  = useRef(null);
  const ollamaRef     = useRef(null);
  const layoutBtnRef  = useRef(null);
  const exportBtnRef  = useRef(null);
  const mergeBtnRef   = useRef(null);

  // Close dropdowns on outside click
  React.useEffect(() => {
    if (!showLayout && !showExport && !showModelMenu && !showMerge) return;
    const handler = () => { setShowLayout(false); setShowExport(false); setShowModelMenu(false); setShowMerge(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showLayout, showExport, showModelMenu, showMerge]);

  const handleToggleModelMenu = () => {
    if (!showModelMenu && ollamaRef.current) {
      setModelMenuRect(ollamaRef.current.getBoundingClientRect());
      setUrlInput(llm.ollamaUrl);
    }
    setShowModelMenu(s => !s);
  };

  const handleUrlSubmit = async (e) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    llmDispatch({ type: 'SET_OLLAMA_URL', payload: trimmed });
    setConnecting(true);
    await checkConnection(trimmed);
    setConnecting(false);
  };

  const isNodeSelected = state.nodes.some(n => n.id === state.selectedId);
  const isEdgeSelected = state.edges.some(e => e.id === state.selectedId);
  const canDelete = isNodeSelected || isEdgeSelected;

  const handleAddNode = () => {
    const cx = ((-state.pan.x + 400) / state.zoom);
    const cy = ((-state.pan.y + 300) / state.zoom);
    dispatch({
      type: 'ADD_NODE',
      payload: {
        id: `node_${Date.now()}`,
        label: 'New Concept',
        type: 'Class',
        x: cx,
        y: cy,
        properties: [],
        description: ''
      }
    });
  };

  const handleDelete = () => {
    if (isNodeSelected) dispatch({ type: 'DELETE_NODE', payload: state.selectedId });
    else if (isEdgeSelected) dispatch({ type: 'DELETE_EDGE', payload: state.selectedId });
  };

  const handleNewFile = () => {
    if (state.nodes.length > 0) {
      if (!window.confirm('현재 그래프를 모두 지우고 새 파일을 시작하시겠습니까?\n저장되지 않은 내용은 사라집니다.')) return;
    }
    dispatch({ type: 'RESET_GRAPH' });
    ruleDispatch({ type: 'LOAD_RULES', payload: [] });
  };

  const handleSave = () => {
    const data = {
      nodes: state.nodes,
      edges: state.edges.filter(e => !e.inferred),
      rules: ruleState.rules,
      meta: { version: '2.0', savedAt: new Date().toISOString() },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `autology_${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  const handleLoad = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        dispatch({ type: 'LOAD_GRAPH', payload: data });
        if (Array.isArray(data.rules)) {
          ruleDispatch({ type: 'LOAD_RULES', payload: data.rules });
        }
      } catch { alert('유효하지 않은 JSON 파일입니다.'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleMergeSelect = (format) => {
    setShowMerge(false);
    setPendingMergeFormat(format);
    const accepts = {
      json: '.json',
      owl:  '.owl,.rdf,.xml',
      ttl:  '.ttl',
      rdf:  '.ttl,.owl,.rdf,.xml,.jsonld,.json',
    };
    if (mergeFileRef.current) {
      mergeFileRef.current.accept = accepts[format] || '*';
      mergeFileRef.current.click();
    }
  };

  const handleMergeLoad = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const format = pendingMergeFormat;
    const sourceName = file.name.replace(/\.[^.]+$/, '');
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const text = ev.target.result;
        let parsed;
        if (format === 'json') {
          const data = JSON.parse(text);
          parsed = { nodes: data.nodes || [], edges: data.edges || [] };
          if (Array.isArray(data.rules)) {
            ruleDispatch({ type: 'LOAD_RULES', payload: data.rules });
          }
        } else if (format === 'owl') {
          parsed = parseOWL(text);
        } else if (format === 'ttl') {
          parsed = parseTurtle(text);
        } else if (format === 'rdf') {
          const ext = file.name.toLowerCase().split('.').pop();
          const rdfFormat = ext === 'jsonld' || ext === 'json' ? 'json-ld'
            : ext === 'owl' || ext === 'rdf' || ext === 'xml' ? 'xml'
            : 'turtle';
          parsed = await importWithRDFLib(text, rdfFormat);
        } else {
          alert('지원하지 않는 형식입니다.');
          return;
        }
        dispatch({ type: 'MERGE_GRAPH', payload: { ...parsed, sourceName } });
      } catch (err) {
        alert(`파일 파싱 실패: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
    setPendingMergeFormat(null);
  };

  const handleExport = async (type) => {
    setShowExport(false);
    try {
      const { nodes, edges } = state;
      if (type === 'mermaid')  saveMermaid(nodes, edges);
      if (type === 'markdown') saveMarkdown(nodes, edges);
      if (type === 'cypher')   saveCypher(nodes, edges);
      if (type === 'svg')      saveSVG(nodes, edges);
      if (type === 'png')      await savePNG(nodes, edges);
      if (type === 'turtle') {
        const text = exportToTurtle(nodes, edges);
        _download(text, `autology_${_today()}.ttl`, 'text/turtle');
      }
      if (type === 'owl') {
        const text = exportToOWL(nodes, edges);
        _download(text, `autology_${_today()}.owl`, 'application/rdf+xml');
      }
      if (type === 'jsonld') {
        const text = await exportWithRDFLib({ nodes, edges }, 'json-ld');
        _download(text, `autology_${_today()}.jsonld`, 'application/ld+json');
      }
      if (type === 'rdfxml') {
        const text = await exportWithRDFLib({ nodes, edges }, 'xml');
        _download(text, `autology_${_today()}_rdflib.rdf`, 'application/rdf+xml');
      }
    } catch (err) {
      alert(`내보내기 실패: ${err.message}`);
    }
  };

  function _today() { return new Date().toISOString().slice(0, 10); }
  function _download(text, filename, mime) {
    const blob = new Blob([text], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  const handleAutoConnect = () => {
    const { nodes, edges } = state;
    const literalNodes = nodes.filter(n => n.type === 'Literal');
    if (literalNodes.length === 0) {
      alert('연결할 Literal 노드가 없습니다.\n직위, 소속법인 등의 Literal 노드를 먼저 만들어주세요.');
      return;
    }

    const normalize = (v) => v ? v.replace(/[()（）]/g, '').trim() : '';

    const newEdges = [];
    const now = Date.now();

    nodes.forEach(node => {
      if (node.type !== 'Instance') return;
      const props = Array.isArray(node.properties) ? node.properties : [];
      props.forEach(({ key, value }) => {
        if (!value) return;
        const normValue = normalize(value);
        const normKey   = normalize(key);
        // 전략1: property value가 Literal label과 일치 (예: 직위:"이사" → Literal "이사")
        // 전략2: property key가 Literal label과 일치 (예: 소속법인:"..." → Literal "소속법인")
        const literal =
          literalNodes.find(l => normalize(l.label) === normValue) ||
          literalNodes.find(l => normalize(l.label) === normKey);
        if (!literal) return;
        const alreadyExists = edges.some(
          e => e.source === node.id && e.target === literal.id && e.label === key
        ) || newEdges.some(
          e => e.source === node.id && e.target === literal.id && e.label === key
        );
        if (alreadyExists) return;
        newEdges.push({
          id: `auto_${now}_${newEdges.length}`,
          source: node.id,
          target: literal.id,
          label: key,
          style: 'solid',
          direction: 'forward',
          inferred: false,
        });
      });
    });

    if (newEdges.length === 0) {
      alert('새로 연결할 엣지가 없습니다.\n(이미 모두 연결되어 있거나 매칭되는 Literal 노드가 없습니다)');
      return;
    }

    newEdges.forEach(edge => dispatch({ type: 'ADD_EDGE', payload: edge }));
    alert(`${newEdges.length}개의 엣지가 자동으로 생성되었습니다.`);
  };

  const handleLayout = (type) => {
    if (state.nodes.length === 0) return;
    let positions;
    if (type === 'hierarchical') positions = hierarchicalLayout(state.nodes, state.edges);
    else if (type === 'radial')  positions = radialLayout(state.nodes, state.edges);
    else                          positions = forceLayout(state.nodes, state.edges);
    dispatch({ type: 'APPLY_LAYOUT', payload: positions });
    setShowLayout(false);
  };

  const handleSearch = (q) => {
    setSearchQuery(q);
    if (!q.trim()) {
      dispatch({ type: 'CLEAR_HIGHLIGHT' });
      return;
    }
    const matched = searchNodes(state.nodes, q);
    dispatch({
      type: 'SET_HIGHLIGHT',
      payload: { nodeIds: matched.map(n => n.id), edgeIds: [] },
    });
  };

  return (
    <header className="toolbar">
      {/* Logo */}
      <div className="toolbar-logo">
        <span className="toolbar-logo-icon">⬡</span>
        <span className="toolbar-logo-text">Autology</span>
      </div>

      <div className="toolbar-divider" />

      {/* File */}
      <div className="toolbar-group">
        <Btn icon={<FilePlus2 size={15} />} label="새 파일" onClick={handleNewFile} />
        <Btn icon={<Save size={15} />} label="Save JSON" onClick={handleSave} />
        <Btn icon={<FolderOpen size={15} />} label="Load JSON (교체)" onClick={() => fileRef.current?.click()} />
        <Btn
          ref={mergeBtnRef}
          icon={<FolderPlus size={15} />}
          label="그래프 추가 병합"
          active={showMerge}
          onClick={() => {
            if (!showMerge && mergeBtnRef.current) setMergeMenuRect(mergeBtnRef.current.getBoundingClientRect());
            setShowMerge(s => !s);
          }}
        />
        <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleLoad} />
        <input ref={mergeFileRef} type="file" style={{ display: 'none' }} onChange={handleMergeLoad} />
      </div>

      <div className="toolbar-divider" />

      {/* History */}
      <div className="toolbar-group">
        <Btn icon={<Undo2 size={15} />} label="Undo (Ctrl+Z)" onClick={() => dispatch({ type: 'UNDO' })} />
        <Btn icon={<Redo2 size={15} />} label="Redo (Ctrl+Y)" onClick={() => dispatch({ type: 'REDO' })} />
      </div>

      <div className="toolbar-divider" />

      {/* Mode */}
      <div className="toolbar-group">
        <Btn
          icon={<MousePointer2 size={15} />}
          label="Select (V)"
          active={state.mode === 'select'}
          onClick={() => dispatch({ type: 'SET_MODE', payload: 'select' })}
        />
        <Btn
          icon={<Hand size={15} />}
          label="Pan (H)"
          active={state.mode === 'panning'}
          onClick={() => dispatch({ type: 'SET_MODE', payload: 'panning' })}
        />
      </div>

      <div className="toolbar-divider" />

      {/* Graph ops */}
      <div className="toolbar-group">
        <Btn icon={<PlusCircle size={15} />} label="Add Node" onClick={handleAddNode} />
        <Btn icon={<Trash2 size={15} />} label="Delete (Del)" disabled={!canDelete} onClick={handleDelete} danger />
        <Btn
          icon={<Link2 size={15} />}
          label="속성 자동 연결 (Instance → Literal)"
          onClick={handleAutoConnect}
          disabled={state.nodes.length === 0}
        />
      </div>

      <div className="toolbar-divider" />

      {/* Auto layout & Export */}
      <div className="toolbar-group">
        <Btn
          icon={<BarChart2 size={15} />}
          label="그래프 품질 평가"
          onClick={() => setShowEvaluator(true)}
          disabled={state.nodes.length === 0}
        />
        <button
          className="toolbar-semantic-btn"
          onClick={() => setShowSemantic(true)}
          disabled={state.nodes.length === 0}
          title="Semantic Workbench: SPARQL / SHACL / RDF"
        >
          <Database size={14} />
          <span>Semantic</span>
        </button>
        <Btn
          ref={layoutBtnRef}
          icon={<LayoutGrid size={15} />}
          label="자동 레이아웃"
          active={showLayout}
          onClick={() => {
            if (!showLayout && layoutBtnRef.current) setLayoutMenuRect(layoutBtnRef.current.getBoundingClientRect());
            setShowLayout(s => !s);
          }}
          disabled={state.nodes.length === 0}
        />
        <Btn
          ref={exportBtnRef}
          icon={<Download size={15} />}
          label="내보내기"
          active={showExport}
          onClick={() => {
            if (!showExport && exportBtnRef.current) setExportMenuRect(exportBtnRef.current.getBoundingClientRect());
            setShowExport(s => !s);
          }}
          disabled={state.nodes.length === 0}
        />
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Search */}
      <div className="toolbar-search">
        <Search size={12} className="toolbar-search-icon" />
        <input
          className="toolbar-search-input"
          placeholder="노드 검색..."
          value={searchQuery}
          onChange={e => handleSearch(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') { handleSearch(''); } }}
        />
        {searchQuery && (
          <button className="toolbar-search-clear" onClick={() => handleSearch('')}>
            <X size={10} />
          </button>
        )}
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <Btn
          icon={<MessageSquare size={15} />}
          label="지식 그래프 AI 테스트"
          onClick={onOpenChat}
        />
      </div>

      <div className="toolbar-divider" />

      {/* LLM section */}
      <div className="toolbar-llm">
        <div className="toolbar-ollama" ref={ollamaRef} onClick={handleToggleModelMenu}>
          {llm.ollamaOnline
            ? <Wifi size={12} className="ollama-online" />
            : <WifiOff size={12} className="ollama-offline" />}
          <span className="ollama-model">{llm.model}</span>
          <ChevronDown size={11} className="ollama-chevron" />
        </div>
      </div>

      {showMerge && mergeMenuRect && ReactDOM.createPortal(
        <div
          className="layout-menu glass"
          style={{ position: 'fixed', top: mergeMenuRect.bottom + 6, left: mergeMenuRect.left, zIndex: 9999, minWidth: 200 }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="merge-menu-header">그래프 추가 병합</div>
          <button className="layout-item" onClick={() => handleMergeSelect('json')}>
            <span className="layout-icon">📋</span>
            <div>
              <div className="merge-item-label">JSON 파일 병합</div>
              <div className="merge-item-desc">.json</div>
            </div>
          </button>
          <button className="layout-item" onClick={() => handleMergeSelect('owl')}>
            <span className="layout-icon">🦉</span>
            <div>
              <div className="merge-item-label">OWL/RDF-XML 병합</div>
              <div className="merge-item-desc">.owl · .rdf · .xml</div>
            </div>
          </button>
          <button className="layout-item" onClick={() => handleMergeSelect('ttl')}>
            <span className="layout-icon">🐢</span>
            <div>
              <div className="merge-item-label">Turtle 병합</div>
              <div className="merge-item-desc">.ttl</div>
            </div>
          </button>
          <button className="layout-item" onClick={() => handleMergeSelect('rdf')}>
            <span className="layout-icon">RDF</span>
            <div>
              <div className="merge-item-label">RDFLib 표준 파서</div>
              <div className="merge-item-desc">ttl · rdf/xml · json-ld</div>
            </div>
          </button>
        </div>,
        document.body
      )}
      {showLayout && layoutMenuRect && ReactDOM.createPortal(
        <div
          className="layout-menu glass"
          style={{ position: 'fixed', top: layoutMenuRect.bottom + 6, left: layoutMenuRect.left, zIndex: 9999 }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button className="layout-item" onClick={() => handleLayout('hierarchical')}><span className="layout-icon">⬇</span>계층형</button>
          <button className="layout-item" onClick={() => handleLayout('radial')}><span className="layout-icon">◎</span>방사형</button>
          <button className="layout-item" onClick={() => handleLayout('force')}><span className="layout-icon">◉</span>Force</button>
        </div>,
        document.body
      )}
      {showExport && exportMenuRect && ReactDOM.createPortal(
        <div
          className="layout-menu glass"
          style={{ position: 'fixed', top: exportMenuRect.bottom + 6, left: exportMenuRect.left, zIndex: 9999 }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button className="layout-item" onClick={() => handleExport('mermaid')}><span className="layout-icon">⬡</span>Mermaid</button>
          <button className="layout-item" onClick={() => handleExport('markdown')}><span className="layout-icon">📄</span>Markdown</button>
          <button className="layout-item" onClick={() => handleExport('cypher')}><span className="layout-icon">⬢</span>Cypher</button>
          <button className="layout-item" onClick={() => handleExport('turtle')}><span className="layout-icon">🐢</span>Turtle (.ttl)</button>
          <button className="layout-item" onClick={() => handleExport('owl')}><span className="layout-icon">🦉</span>OWL/RDF-XML</button>
          <button className="layout-item" onClick={() => handleExport('jsonld')}><span className="layout-icon">LD</span>JSON-LD (RDFLib)</button>
          <button className="layout-item" onClick={() => handleExport('rdfxml')}><span className="layout-icon">RDF</span>RDF/XML (RDFLib)</button>
          <button className="layout-item" onClick={() => handleExport('svg')}><span className="layout-icon">🖼</span>SVG</button>
          <button className="layout-item" onClick={() => handleExport('png')}><span className="layout-icon">📷</span>PNG</button>
        </div>,
        document.body
      )}
      {showEvaluator && <GraphEvaluator onClose={() => setShowEvaluator(false)} />}
      {showSemantic && <SemanticWorkbench onClose={() => setShowSemantic(false)} />}
      {showModelMenu && modelMenuRect && ReactDOM.createPortal(
        <div
          className="model-menu glass"
          style={{
            position: 'fixed',
            top: modelMenuRect.bottom + 6,
            right: window.innerWidth - modelMenuRect.right,
            zIndex: 9999,
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          <form className="model-url-form" onSubmit={handleUrlSubmit}>
            <input
              className="model-url-input"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              placeholder="http://host:11434"
              spellCheck={false}
            />
            <button type="submit" className="model-url-btn" disabled={connecting}>
              {connecting ? '…' : '연결'}
            </button>
          </form>
          <div className="model-menu-divider" />
          {connecting && (
            <div className="model-item model-item--empty">연결 중...</div>
          )}
          {!connecting && llm.availableModels.length === 0 && (
            <div className="model-item model-item--empty">모델 없음 (연결 확인)</div>
          )}
          {llm.availableModels.map(m => (
            <div
              key={m}
              className={`model-item${m === llm.model ? ' model-item--active' : ''}`}
              onClick={() => { llmDispatch({ type: 'SET_MODEL', payload: m }); setShowModelMenu(false); }}
            >
              {m}
            </div>
          ))}
        </div>,
        document.body
      )}
    </header>
  );
}

const Btn = React.forwardRef(function Btn({ icon, label, onClick, active, disabled, danger }, ref) {
  return (
    <button
      ref={ref}
      className={['toolbar-btn', active ? 'toolbar-btn--active' : '', danger ? 'toolbar-btn--danger' : ''].join(' ')}
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      {icon}
    </button>
  );
});

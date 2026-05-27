import React, { useContext, useEffect, useRef, useState, useCallback } from 'react';
import GraphContext from '../../context/GraphContext';
import { exportToOWL, exportToTurtle, parseOWL, parseTurtle } from '../../utils/ontologyIO';
import './CodeEditorPanel.css';

export default function CodeEditorPanel({ format }) {
  const { state, dispatch } = useContext(GraphContext);
  const [code, setCode] = useState('');
  const [parseError, setParseError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const prevGraphRef = useRef(null);
  const textareaRef = useRef(null);

  // Graph → code (only when graph changes externally, not from our own apply)
  const graphKey = JSON.stringify({ nodes: state.nodes, edges: state.edges });
  useEffect(() => {
    if (applying) return;
    if (prevGraphRef.current === graphKey) return;
    prevGraphRef.current = graphKey;
    const generated = format === 'xml'
      ? exportToOWL(state.nodes, state.edges)
      : exportToTurtle(state.nodes, state.edges);
    setCode(generated);
    setDirty(false);
    setParseError('');
  }, [graphKey, format, applying]);

  const handleChange = useCallback((e) => {
    setCode(e.target.value);
    setDirty(true);
    setParseError('');
  }, []);

  const handleApply = useCallback(() => {
    try {
      const parsed = format === 'xml' ? parseOWL(code) : parseTurtle(code);
      setApplying(true);
      dispatch({ type: 'LOAD_GRAPH', payload: parsed });
      setParseError('');
      setDirty(false);
      // After dispatch settles, allow graph→code sync again
      setTimeout(() => {
        prevGraphRef.current = null;
        setApplying(false);
      }, 50);
    } catch (err) {
      setParseError(err.message || '파싱 오류');
    }
  }, [code, format, dispatch]);

  const handleKeyDown = useCallback((e) => {
    // Tab key → insert 2 spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = textareaRef.current;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = code.slice(0, start) + '  ' + code.slice(end);
      setCode(next);
      setDirty(true);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
    // Ctrl+Enter → apply
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleApply();
    }
  }, [code, handleApply]);

  const label = format === 'xml' ? 'OWL/RDF-XML' : 'Turtle (.ttl)';
  const lineCount = code.split('\n').length;

  return (
    <div className="code-editor-panel">
      <div className="code-editor-header">
        <span className="code-editor-label">{label}</span>
        <span className="code-editor-meta">{lineCount} 줄</span>
        {dirty && <span className="code-editor-dirty">● 미적용</span>}
        <button
          className={`code-editor-apply${dirty ? ' code-editor-apply--active' : ''}`}
          onClick={handleApply}
          title="Ctrl+Enter"
        >
          적용
        </button>
      </div>
      {parseError && (
        <div className="code-editor-error">{parseError}</div>
      )}
      <div className="code-editor-body">
        <div className="code-editor-lines" aria-hidden="true">
          {code.split('\n').map((_, i) => (
            <div key={i} className="code-editor-lineno">{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          className="code-editor-textarea"
          value={code}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={`${label} 코드를 직접 입력하고 [적용] 또는 Ctrl+Enter를 누르세요.`}
        />
      </div>
    </div>
  );
}

import React, { useContext, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { Database, Play, ShieldCheck, X } from 'lucide-react';
import GraphContext from '../../context/GraphContext';
import { exportToTurtle, generateSparqlQueries, buildSparqlDocument, generateShacl } from '../../utils/ontologyIO';
import { getSemanticCapabilities, runSPARQL, validateSHACL } from '../../utils/semanticApi';
import './SemanticWorkbench.css';

export default function SemanticWorkbench({ onClose }) {
  const { state } = useContext(GraphContext);
  const [tab, setTab] = useState('sparql');
  const [caps, setCaps] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  const turtle = useMemo(
    () => exportToTurtle(state.nodes, state.edges),
    [state.nodes, state.edges]
  );
  const genQueries = useMemo(
    () => generateSparqlQueries(state.nodes, state.edges),
    [state.nodes, state.edges]
  );
  const genShapes = useMemo(
    () => generateShacl(state.nodes, state.edges),
    [state.nodes, state.edges]
  );

  // Seed the editors from the graph when the workbench opens; keep them editable.
  // SPARQL has one query per class/relation, picked from a dropdown; SHACL is one
  // document with every shape. Both offer "regenerate" to reset to graph-derived.
  const [queryIdx, setQueryIdx] = useState(0);
  const [query, setQuery] = useState(() => buildSparqlDocument(genQueries, 0));
  const [shapes, setShapes] = useState(genShapes);

  // The editor shows the full query set; the dropdown picks which one is active
  // (uncommented) so Run executes exactly that query.
  const selectQuery = idx => {
    setQueryIdx(idx);
    setQuery(buildSparqlDocument(genQueries, idx));
  };

  useEffect(() => {
    getSemanticCapabilities()
      .then(setCaps)
      .catch(() => setCaps({ rdflib: false, pyshacl: false }));
  }, []);


  const runQuery = async () => {
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const data = await runSPARQL(turtle, query, 'turtle');
      setResult({ type: 'sparql', data });
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  const runShacl = async () => {
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const data = await validateSHACL(turtle, shapes, 'turtle', 'turtle');
      setResult({ type: 'shacl', data });
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="sw-overlay" onClick={onClose}>
      <div className="sw-modal glass" onClick={e => e.stopPropagation()}>
        <div className="sw-header">
          <div>
            <span className="sw-title">Semantic Workbench</span>
            <span className="sw-subtitle">{state.nodes.length} nodes · {state.edges.length} edges · RDFLib / SPARQL / SHACL</span>
          </div>
          <button className="sw-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="sw-status-row">
          <span className={`sw-status ${caps?.rdflib ? 'sw-status--on' : 'sw-status--off'}`}>
            RDFLib {caps?.rdflib ? 'available' : 'missing'}
          </span>
          <span className={`sw-status ${caps?.pyshacl ? 'sw-status--on' : 'sw-status--off'}`}>
            pySHACL {caps?.pyshacl ? 'available' : 'missing'}
          </span>
        </div>

        <div className="sw-tabs">
          <button className={`sw-tab${tab === 'sparql' ? ' sw-tab--active' : ''}`} onClick={() => setTab('sparql')}>
            <Database size={14} /> SPARQL
          </button>
          <button className={`sw-tab${tab === 'shacl' ? ' sw-tab--active' : ''}`} onClick={() => setTab('shacl')}>
            <ShieldCheck size={14} /> SHACL
          </button>
          <button className={`sw-tab${tab === 'rdf' ? ' sw-tab--active' : ''}`} onClick={() => setTab('rdf')}>
            Turtle
          </button>
        </div>

        {tab === 'sparql' && (
          <div className="sw-grid">
            <Editor
              title="SPARQL Query"
              value={query}
              onChange={setQuery}
              onRegenerate={() => selectQuery(queryIdx)}
              headExtra={
                <select
                  className="sw-query-select"
                  value={queryIdx}
                  onChange={e => selectQuery(Number(e.target.value))}
                >
                  {genQueries.map((qq, i) => (
                    <option key={i} value={i}>{qq.title}</option>
                  ))}
                </select>
              }
            />
            <ResultPanel
              actionLabel="Run Query"
              icon={<Play size={13} />}
              running={running}
              onRun={runQuery}
              error={error}
              result={result?.type === 'sparql' ? <SparqlResult data={result.data} /> : null}
            />
          </div>
        )}

        {tab === 'shacl' && (
          <div className="sw-grid">
            <Editor
              title="SHACL Shapes"
              value={shapes}
              onChange={setShapes}
              onRegenerate={() => setShapes(genShapes)}
            />
            <ResultPanel
              actionLabel="Validate"
              icon={<ShieldCheck size={13} />}
              running={running}
              onRun={runShacl}
              error={error}
              result={result?.type === 'shacl' ? <ShaclResult data={result.data} /> : null}
            />
          </div>
        )}

        {tab === 'rdf' && (
          <div className="sw-rdf-panel">
            <Editor title="Current Graph as Turtle" value={turtle} readOnly />
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function Editor({ title, value, onChange, readOnly = false, onRegenerate, headExtra }) {
  return (
    <div className="sw-editor">
      <div className="sw-editor-head">
        <span className="sw-panel-title">{title}</span>
        <div className="sw-editor-head-actions">
          {headExtra}
          {onRegenerate && (
            <button className="sw-regen-btn" onClick={onRegenerate} title="현재 그래프에서 다시 생성">
              그래프에서 재생성
            </button>
          )}
        </div>
      </div>
      <textarea
        className="sw-textarea"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        onChange={e => onChange?.(e.target.value)}
      />
    </div>
  );
}

function ResultPanel({ actionLabel, icon, running, onRun, error, result }) {
  return (
    <div className="sw-result">
      <div className="sw-result-header">
        <span className="sw-panel-title">Result</span>
        <button className="sw-run-btn" onClick={onRun} disabled={running}>
          {running ? 'Running...' : <>{icon}{actionLabel}</>}
        </button>
      </div>
      {error && <div className="sw-error">{error}</div>}
      {!error && result}
      {!error && !result && <div className="sw-empty">Run the semantic check to see results here.</div>}
    </div>
  );
}

function SparqlResult({ data }) {
  if (!data?.rows?.length) return <div className="sw-empty">No rows returned.</div>;
  return (
    <div className="sw-table-wrap">
      <table className="sw-table">
        <thead>
          <tr>{data.variables.map(v => <th key={v}>{v}</th>)}</tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={i}>
              {data.variables.map(v => <td key={v}>{row[v] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShaclResult({ data }) {
  return (
    <div className="sw-shacl">
      <div className={`sw-conforms ${data.conforms ? 'sw-conforms--yes' : 'sw-conforms--no'}`}>
        {data.conforms ? 'Conforms' : 'Violations found'}
      </div>
      <pre className="sw-pre">{data.report_text}</pre>
    </div>
  );
}

import React, { useContext, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { Database, Play, ShieldCheck, X } from 'lucide-react';
import GraphContext from '../../context/GraphContext';
import { exportToTurtle } from '../../utils/ontologyIO';
import { getSemanticCapabilities, runSPARQL, validateSHACL } from '../../utils/semanticApi';
import './SemanticWorkbench.css';

const DEFAULT_QUERY = `PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

SELECT ?subject ?predicate ?object
WHERE {
  ?subject ?predicate ?object .
}
LIMIT 25`;

const DEFAULT_SHAPES = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix : <http://autology.local/ontology#> .

:ClassLabelShape
  a sh:NodeShape ;
  sh:targetClass owl:Class ;
  sh:property [
    sh:path rdfs:label ;
    sh:minCount 1 ;
  ] .`;

export default function SemanticWorkbench({ onClose }) {
  const { state } = useContext(GraphContext);
  const [tab, setTab] = useState('sparql');
  const [caps, setCaps] = useState(null);
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [shapes, setShapes] = useState(DEFAULT_SHAPES);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  const turtle = useMemo(
    () => exportToTurtle(state.nodes, state.edges),
    [state.nodes, state.edges]
  );

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
            <Editor title="SPARQL Query" value={query} onChange={setQuery} />
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
            <Editor title="SHACL Shapes" value={shapes} onChange={setShapes} />
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

function Editor({ title, value, onChange, readOnly = false }) {
  return (
    <div className="sw-editor">
      <div className="sw-panel-title">{title}</div>
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

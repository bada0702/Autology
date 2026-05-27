import React, { useContext, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { Database, Play, ShieldCheck, X } from 'lucide-react';
import GraphContext from '../../context/GraphContext';
import { exportToTurtle } from '../../utils/ontologyIO';
import { getSemanticCapabilities, runSPARQL, validateSHACL } from '../../utils/semanticApi';
import './SemanticWorkbench.css';

const BASE_IRI = 'http://autology.local/ontology#';

function toLocal(str) {
  return String(str || '').replace(/\s+/g, '_').replace(/[^\w\-.]/g, '') || 'node';
}

function generateSparql(nodes, edges) {
  const classNodes  = nodes.filter(n => n.type === 'Class');
  const edgeLabels  = [...new Set(edges.map(e => e.label).filter(Boolean))].slice(0, 6);

  const lines = [
    'PREFIX owl:  <http://www.w3.org/2002/07/owl#>',
    'PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>',
    'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
    `PREFIX :     <${BASE_IRI}>`,
    '',
  ];

  if (classNodes.length === 0) {
    lines.push('SELECT ?subject ?predicate ?object');
    lines.push('WHERE {');
    lines.push('  ?subject ?predicate ?object .');
    lines.push('}');
    lines.push('LIMIT 25');
    return lines.join('\n');
  }

  if (edgeLabels.length > 0) {
    lines.push('SELECT ?from ?rel ?to');
    lines.push('WHERE {');
    lines.push('  ?from ?rel ?to .');
    lines.push(`  VALUES ?rel { ${edgeLabels.map(l => `:${toLocal(l)}`).join(' ')} }`);
    lines.push('}');
    lines.push('LIMIT 50');
  } else {
    lines.push(`SELECT ?cls ?label`);
    lines.push('WHERE {');
    lines.push('  ?cls a owl:Class .');
    lines.push('  OPTIONAL { ?cls rdfs:label ?label . }');
    lines.push('}');
  }

  return lines.join('\n');
}

function generateShacl(nodes, edges) {
  const classNodes = nodes.filter(n => n.type === 'Class');

  const header = [
    '@prefix sh:   <http://www.w3.org/ns/shacl#> .',
    '@prefix owl:  <http://www.w3.org/2002/07/owl#> .',
    '@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    `@prefix :     <${BASE_IRI}> .`,
    '',
  ].join('\n');

  if (classNodes.length === 0) {
    return header + '# Class 타입 노드가 없습니다. Class 노드를 추가하면 Shape이 자동 생성됩니다.';
  }

  const edgesBySource = {};
  for (const e of edges) {
    (edgesBySource[e.source] = edgesBySource[e.source] || []).push(e);
  }
  const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));

  const blocks = classNodes.map(cls => {
    const name = toLocal(cls.label);

    const propBlocks = [];

    // label 필수
    propBlocks.push('    sh:path rdfs:label ;\n    sh:minCount 1 ;');

    // 노드에 정의된 속성
    for (const p of (cls.properties || [])) {
      if (!p.key) continue;
      propBlocks.push(`    sh:path :${toLocal(p.key)} ;\n    sh:minCount 1 ;`);
    }

    // 나가는 엣지(비추론, 실제 관계)
    for (const e of (edgesBySource[cls.id] || [])) {
      const lbl = e.label;
      if (!lbl || lbl === 'rdf:type' || lbl === 'rdfs:subClassOf' || e.inferred) continue;
      const pred = toLocal(lbl);
      const tgt  = nodeById[e.target];
      let block = `    sh:path :${pred} ;`;
      if (tgt?.type === 'Class') block += `\n    sh:class :${toLocal(tgt.label)} ;`;
      propBlocks.push(block);
    }

    const shapeLines = [
      `:${name}Shape`,
      '  a sh:NodeShape ;',
      `  sh:targetClass :${name} ;`,
      ...propBlocks.map((pb, i) =>
        `  sh:property [\n${pb}\n  ]${i < propBlocks.length - 1 ? ' ;' : ' .'}`
      ),
    ];
    return shapeLines.join('\n');
  });

  return header + blocks.join('\n\n');
}

export default function SemanticWorkbench({ onClose }) {
  const { state } = useContext(GraphContext);
  const [tab, setTab]       = useState('sparql');
  const [caps, setCaps]     = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError]   = useState('');
  const [running, setRunning] = useState(false);

  const turtle = useMemo(
    () => exportToTurtle(state.nodes, state.edges),
    [state.nodes, state.edges]
  );

  const autoQuery  = useMemo(() => generateSparql(state.nodes, state.edges),  [state.nodes, state.edges]);
  const autoShapes = useMemo(() => generateShacl(state.nodes, state.edges), [state.nodes, state.edges]);

  const [query,  setQuery]  = useState(autoQuery);
  const [shapes, setShapes] = useState(autoShapes);

  // 그래프 변경 시 자동 재생성 (탭 전환 전까지 덮어쓰지 않음)
  const [queryEdited,  setQueryEdited]  = useState(false);
  const [shapesEdited, setShapesEdited] = useState(false);

  useEffect(() => { if (!queryEdited)  setQuery(autoQuery);   }, [autoQuery,  queryEdited]);
  useEffect(() => { if (!shapesEdited) setShapes(autoShapes); }, [autoShapes, shapesEdited]);

  useEffect(() => {
    getSemanticCapabilities()
      .then(setCaps)
      .catch(() => setCaps({ rdflib: false, pyshacl: false }));
  }, []);

  const runQuery = async () => {
    setRunning(true); setError(''); setResult(null);
    try {
      const data = await runSPARQL(turtle, query, 'turtle');
      setResult({ type: 'sparql', data });
    } catch (err) { setError(err.message); }
    finally { setRunning(false); }
  };

  const runShacl = async () => {
    setRunning(true); setError(''); setResult(null);
    try {
      const data = await validateSHACL(turtle, shapes, 'turtle', 'turtle');
      setResult({ type: 'shacl', data });
    } catch (err) { setError(err.message); }
    finally { setRunning(false); }
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
          <span className={`sw-status ${caps?.rdflib  ? 'sw-status--on' : 'sw-status--off'}`}>
            RDFLib {caps?.rdflib  ? 'available' : 'missing'}
          </span>
          <span className={`sw-status ${caps?.pyshacl ? 'sw-status--on' : 'sw-status--off'}`}>
            pySHACL {caps?.pyshacl ? 'available' : 'missing'}
          </span>
        </div>

        <div className="sw-tabs">
          <button className={`sw-tab${tab === 'sparql' ? ' sw-tab--active' : ''}`} onClick={() => setTab('sparql')}>
            <Database size={14} /> SPARQL
          </button>
          <button className={`sw-tab${tab === 'shacl'  ? ' sw-tab--active' : ''}`} onClick={() => setTab('shacl')}>
            <ShieldCheck size={14} /> SHACL
          </button>
          <button className={`sw-tab${tab === 'rdf'    ? ' sw-tab--active' : ''}`} onClick={() => setTab('rdf')}>
            Turtle
          </button>
        </div>

        {tab === 'sparql' && (
          <div className="sw-grid">
            <Editor
              title="SPARQL Query"
              value={query}
              onChange={v => { setQueryEdited(true); setQuery(v); }}
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
              onChange={v => { setShapesEdited(true); setShapes(v); }}
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
      {error  && <div className="sw-error">{error}</div>}
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
        <thead><tr>{data.variables.map(v => <th key={v}>{v}</th>)}</tr></thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={i}>{data.variables.map(v => <td key={v}>{row[v] ?? ''}</td>)}</tr>
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
        {data.conforms ? '✓ Conforms' : '✗ Violations found'}
      </div>
      <pre className="sw-pre">{data.report_text}</pre>
    </div>
  );
}

import React, { useContext, useMemo, useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { X, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import GraphContext from '../../context/GraphContext';
import RuleContext from '../../context/RuleContext';
import LLMContext, { makeOllamaFetch } from '../../context/LLMContext';
import { evaluateGraph } from '../../utils/graphEvaluator';
import { validateSemanticRules } from '../../utils/ruleEngine';
import './GraphEvaluator.css';

// ── 미니 바 차트 ──────────────────────────────────────────────
function BarChart({ items, color }) {
  const max = Math.max(...items.map(d => d.value), 1);
  return (
    <div className="ev-bar-chart">
      {items.map((d, i) => (
        <div key={i} className="ev-bar-row">
          <div className="ev-bar-label">{d.label}</div>
          <div className="ev-bar-track">
            <div
              className="ev-bar-fill"
              style={{ width: `${(d.value / max) * 100}%`, background: color }}
            />
          </div>
          <div className="ev-bar-val" style={{ color }}>{d.value}</div>
          <div className="ev-bar-desc">{d.desc}</div>
        </div>
      ))}
    </div>
  );
}

// ── 레이더 차트 (SVG) ─────────────────────────────────────────
function RadarChart({ scores }) {
  const cx = 110, cy = 110, r = 80;
  const keys = Object.keys(scores);
  const n = keys.length;
  const angleStep = (2 * Math.PI) / n;

  function point(i, val) {
    const angle = i * angleStep - Math.PI / 2;
    const ratio = val / 100;
    return {
      x: cx + r * ratio * Math.cos(angle),
      y: cy + r * ratio * Math.sin(angle),
    };
  }
  function labelPoint(i) {
    const angle = i * angleStep - Math.PI / 2;
    return {
      x: cx + (r + 22) * Math.cos(angle),
      y: cy + (r + 22) * Math.sin(angle),
    };
  }

  // grid rings
  const rings = [25, 50, 75, 100];
  const gridLines = rings.map(v =>
    keys.map((_, i) => point(i, v)).map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z'
  );

  // axes
  const axes = keys.map((_, i) => {
    const p = point(i, 100);
    return `M ${cx} ${cy} L ${p.x} ${p.y}`;
  });

  // data polygon
  const dataPts = keys.map((k, i) => point(i, scores[k]));
  const dataPath = dataPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z';

  const LABELS = {
    structure: '구조',
    ontology: '규칙',
    completeness: '완성도',
    ragCognition: 'RAG 인지',
    searchPerf: '검색 속도',
  };
  const COLORS = ['#818cf8','#34d399','#fbbf24','#f472b6','#60a5fa'];

  return (
    <svg width="220" height="220" className="ev-radar">
      {/* Grid */}
      {gridLines.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
      ))}
      {/* Axes */}
      {axes.map((d, i) => (
        <path key={i} d={d} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
      ))}
      {/* Data fill */}
      <path d={dataPath} fill="rgba(129,140,248,0.15)" stroke="#818cf8" strokeWidth="1.5" />
      {/* Data points */}
      {dataPts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3.5" fill={COLORS[i % COLORS.length]} />
      ))}
      {/* Labels */}
      {keys.map((k, i) => {
        const lp = labelPoint(i);
        return (
          <text
            key={i}
            x={lp.x}
            y={lp.y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="9.5"
            fill={COLORS[i % COLORS.length]}
            fontWeight="600"
          >
            {LABELS[k] || k}
          </text>
        );
      })}
      {/* Center score */}
      <text x={cx} y={cy - 6} textAnchor="middle" fontSize="22" fontWeight="700" fill="#eef2ff">
        {Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / n)}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.4)">종합</text>
    </svg>
  );
}

// ── 도넛 점수 ─────────────────────────────────────────────────
function ScoreRing({ score, color, size = 64 }) {
  const r = (size - 8) / 2, circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <svg width={size} height={size} className="ev-ring">
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="5" />
      <circle
        cx={size/2} cy={size/2} r={r}
        fill="none" stroke={color} strokeWidth="5"
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`}
      />
      <text x={size/2} y={size/2 + 1} textAnchor="middle" dominantBaseline="middle"
        fontSize="13" fontWeight="700" fill={color}>{score}</text>
    </svg>
  );
}

// ── 위반 뱃지 ─────────────────────────────────────────────────
function ViolationList({ violations }) {
  if (!violations.length) return <p className="ev-ok">위반 사항 없음 ✓</p>;
  return (
    <ul className="ev-violation-list">
      {violations.map((v, i) => (
        <li key={i} className={`ev-violation ev-violation--${v.severity}`}>
          <span className="ev-violation-icon">{v.severity === 'error' ? '✕' : '!'}</span>
          <span className="ev-violation-rule">{v.rule}</span>
          <span className="ev-violation-count">{v.count}건</span>
        </li>
      ))}
    </ul>
  );
}

// ── 섹션 아코디언 ─────────────────────────────────────────────
function Section({ title, score, color, icon, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="ev-section">
      <button className="ev-section-header" onClick={() => setOpen(o => !o)}>
        <span className="ev-section-icon">{icon}</span>
        <span className="ev-section-title">{title}</span>
        <ScoreRing score={score} color={color} size={44} />
        <span className="ev-section-chevron">{open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</span>
      </button>
      {open && <div className="ev-section-body">{children}</div>}
    </div>
  );
}

// ── LLM 평가 패널 ─────────────────────────────────────────────
function LLMEvalPanel({ nodes, edges }) {
  const { state: llm } = useContext(LLMContext);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const run = useCallback(async () => {
    if (!llm.ollamaOnline) { setErr('Ollama 오프라인'); return; }
    setLoading(true); setErr(''); setResult(null);
    const nodesText = nodes.map(n =>
      `- [${n.type}] ${n.label}${n.description ? ': ' + n.description.slice(0, 60) : ''}`
    ).join('\n');
    const edgesText = edges.filter(e => !e.inferred).map(e => {
      const s = nodes.find(n => n.id === e.source)?.label || e.source;
      const t = nodes.find(n => n.id === e.target)?.label || e.target;
      return `- ${s} -[${e.label || '?'}]-> ${t}`;
    }).join('\n');

    const prompt = `다음 온톨로지 지식 그래프를 전문가 관점에서 평가해줘.

[노드]
${nodesText || '(없음)'}

[관계]
${edgesText || '(없음)'}

다음 항목을 각 1-2문장으로 평가하고 점수(0-100)를 매겨줘:
1. 개념 완결성 (중요 개념이 빠짐없이 포함됐는가)
2. 관계 논리성 (관계 레이블이 명확하고 논리적인가)
3. 도메인 일관성 (같은 도메인의 용어를 일관되게 사용하는가)
4. 개선 제안 (구체적으로 2-3가지)

반드시 한국어로 답변해.`;

    try {
      const res = await makeOllamaFetch(llm.ollamaUrl, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: llm.model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResult(data.message?.content || '');
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [nodes, edges, llm]);

  return (
    <div className="ev-llm">
      <div className="ev-llm-header">
        <span className="ev-llm-badge">{llm.ollamaOnline ? '● 온라인' : '● 오프라인'}</span>
        <span className="ev-llm-model">{llm.model}</span>
        <button className="ev-llm-btn" onClick={run} disabled={loading || !llm.ollamaOnline}>
          {loading ? <RefreshCw size={12} className="ev-spin" /> : 'AI 평가 실행'}
        </button>
      </div>
      {err && <p className="ev-llm-err">{err}</p>}
      {result && <pre className="ev-llm-result">{result}</pre>}
      {!result && !loading && <p className="ev-llm-hint">버튼을 누르면 Ollama LLM이 그래프를 의미적으로 평가합니다.</p>}
    </div>
  );
}

// ── 메인 모달 ────────────────────────────────────────────────
export default function GraphEvaluator({ onClose }) {
  const { state } = useContext(GraphContext);
  const { state: ruleState } = useContext(RuleContext);
  const { nodes, edges } = state;

  const ev = useMemo(() => evaluateGraph(nodes, edges), [nodes, edges]);
  const semanticViolations = useMemo(
    () => validateSemanticRules(nodes, edges, ruleState.rules),
    [nodes, edges, ruleState.rules]
  );

  const SECTION_META = [
    { key: 'structure',    title: '구조 평가',      icon: '🔷', color: '#818cf8' },
    { key: 'ontology',     title: '온톨로지 규칙',  icon: '📐', color: '#f472b6' },
    { key: 'completeness', title: '완성도',          icon: '✅', color: '#34d399' },
    { key: 'ragCognition', title: 'RAG 인지 성능',  icon: '🧠', color: '#fbbf24' },
    { key: 'searchPerf',   title: '검색 속도 추정', icon: '⚡', color: '#60a5fa' },
  ];

  const radarScores = {
    structure:    ev.structure.score,
    ontology:     ev.ontology.score,
    completeness: ev.completeness.score,
    ragCognition: ev.ragCognition.score,
    searchPerf:   ev.searchPerf.score,
  };

  const scoreColor = (s) => s >= 80 ? '#34d399' : s >= 55 ? '#fbbf24' : '#f87171';

  return ReactDOM.createPortal(
    <div className="ev-overlay" onClick={onClose}>
      <div className="ev-modal glass" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="ev-header">
          <span className="ev-header-title">지식 그래프 품질 평가</span>
          <span className="ev-header-sub">{nodes.length}개 노드 · {edges.filter(e=>!e.inferred).length}개 엣지</span>
          <button className="ev-close" onClick={onClose}><X size={15}/></button>
        </div>

        <div className="ev-body">
          {/* Overview: Radar + Score cards */}
          <div className="ev-overview">
            <RadarChart scores={radarScores} />
            <div className="ev-score-cards">
              {SECTION_META.map(m => (
                <div key={m.key} className="ev-score-card">
                  <span className="ev-score-card-icon">{m.icon}</span>
                  <div className="ev-score-card-info">
                    <span className="ev-score-card-label">{m.title}</span>
                    <span className="ev-score-card-val" style={{ color: scoreColor(ev[m.key].score) }}>
                      {ev[m.key].score}점
                    </span>
                  </div>
                  <div className="ev-score-card-bar">
                    <div className="ev-score-card-bar-fill"
                      style={{ width: `${ev[m.key].score}%`, background: m.color }} />
                  </div>
                </div>
              ))}
              <div className="ev-overall">
                <span>종합 점수</span>
                <span style={{ color: scoreColor(ev.overall), fontSize: 26, fontWeight: 800 }}>
                  {ev.overall}
                </span>
              </div>
            </div>
          </div>

          <div className="ev-divider" />

          {/* Detail sections */}
          {SECTION_META.map((m, idx) => {
            const data = ev[m.key];
            return (
              <Section
                key={m.key}
                title={m.title}
                score={data.score}
                color={m.color}
                icon={m.icon}
                defaultOpen={idx === 0}
              >
                <BarChart items={data.breakdown} color={m.color} />
                {m.key === 'ontology' && <ViolationList violations={data.violations} />}
                {m.key === 'ontology' && semanticViolations.length > 0 && (
                  <div className="ev-semantic-rules">
                    <p className="ev-token-hint">
                      전문가 규칙 위반: <strong>{semanticViolations.length}건</strong>
                    </p>
                    <ViolationList violations={semanticViolations.map(v => ({
                      rule: v.rule,
                      count: 1,
                      severity: v.severity,
                    }))} />
                  </div>
                )}
                {m.key === 'ragCognition' && (
                  <p className="ev-token-hint">
                    예상 컨텍스트 토큰: <strong>~{ev.ragCognition.tokenEstimate.toLocaleString()}</strong>
                    {ev.ragCognition.tokenEstimate > 8000 && ' — 토큰이 많아 LLM 응답 품질이 저하될 수 있습니다.'}
                  </p>
                )}
                {m.key === 'searchPerf' && (
                  <p className="ev-token-hint">
                    평균 최단 경로: <strong>{ev.searchPerf.avgPathLen}홉</strong>
                    {ev.searchPerf.avgPathLen > 5 && ' — 경로가 길어 멀티홉 RAG에서 성능 저하 가능'}
                  </p>
                )}
              </Section>
            );
          })}

          <div className="ev-divider" />

          {/* LLM 의미 평가 */}
          <div className="ev-section-header-plain">
            <span>🤖</span>
            <span>AI 의미 평가 (Ollama)</span>
          </div>
          <LLMEvalPanel nodes={nodes} edges={edges} />
        </div>
      </div>
    </div>,
    document.body
  );
}

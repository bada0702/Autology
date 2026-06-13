import { useState, useRef, useCallback, useContext } from 'react';
import GraphContext from '../context/GraphContext';

// 개발 모드: Vite(:5173)에서 백엔드(:8000)로 직접 호출.
// 프로덕션(exe): 프론트엔드가 백엔드(:8000)에서 서빙되므로 동일 출처(상대 경로).
const BACKEND = import.meta.env.DEV ? 'http://localhost:8000' : '';
const WS_BASE = import.meta.env.DEV
  ? 'ws://localhost:8000'
  : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

const INITIAL_AGENTS = [
  { name: 'Research Agent',    emoji: '🔍', status: 'pending', message: '', preview: '' },
  { name: 'Extraction Agent',  emoji: '🧠', status: 'pending', message: '', preview: '' },
  { name: 'Relation Agent',    emoji: '🔗', status: 'pending', message: '', preview: '' },
  { name: 'Validation Agent',  emoji: '✅', status: 'pending', message: '', preview: '' },
  { name: 'Editor Agent',      emoji: '✏️', status: 'pending', message: '', preview: '' },
  { name: 'Critic Agent',      emoji: '🔎', status: 'pending', message: '', preview: '' },
];

const TOTAL_AGENTS = INITIAL_AGENTS.length;

export function useCrewAI() {
  const { dispatch } = useContext(GraphContext);
  const [agents, setAgents]             = useState(INITIAL_AGENTS);
  const [jobStatus, setJobStatus]       = useState('idle');
  const [backendOnline, setBackendOnline] = useState(null);
  const [error, setError]               = useState(null);
  const [result, setResult]             = useState(null);
  const [schemaEvolution, setSchemaEvolution] = useState([]);
  const [memoryApplied, setMemoryApplied]     = useState([]);
  const [memoryPatterns, setMemoryPatterns]   = useState([]);
  const wsRef = useRef(null);

  const checkBackend = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(3000) });
      const ok = r.ok;
      setBackendOnline(ok);
      return ok;
    } catch {
      setBackendOnline(false);
      return false;
    }
  }, []);

  const fetchMemoryPatterns = useCallback(async (domain = '') => {
    try {
      const url = domain
        ? `${BACKEND}/api/memory/patterns?domain=${encodeURIComponent(domain)}`
        : `${BACKEND}/api/memory/patterns`;
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const data = await r.json();
        setMemoryPatterns(data.patterns || []);
        return data.patterns || [];
      }
    } catch {}
    return [];
  }, []);

  const saveMemoryPattern = useCallback(async (domain, original, corrected, note = '') => {
    try {
      const r = await fetch(`${BACKEND}/api/memory/patterns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, original, corrected, note }),
      });
      if (r.ok) {
        fetchMemoryPatterns();
        return await r.json();
      }
    } catch {}
    return null;
  }, [fetchMemoryPatterns]);

  const deleteMemoryPattern = useCallback(async (patternId) => {
    try {
      await fetch(`${BACKEND}/api/memory/patterns/${patternId}`, { method: 'DELETE' });
      setMemoryPatterns(prev => prev.filter(p => p.id !== patternId));
    } catch {}
  }, []);

  const startJob = useCallback(async (topic, options = {}) => {
    setAgents(INITIAL_AGENTS.map(a => ({ ...a })));
    setJobStatus('running');
    setError(null);
    setResult(null);
    setSchemaEvolution([]);
    setMemoryApplied([]);

    await fetchMemoryPatterns(topic);

    let jobId;
    try {
      const res = await fetch(`${BACKEND}/api/crew/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, options }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();
      jobId = data.job_id;
    } catch (err) {
      setError(err.message);
      setJobStatus('failed');
      return;
    }

    const ws = new WebSocket(`${WS_BASE}/ws/crew/${jobId}`);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      const event = JSON.parse(evt.data);

      if (event.type === 'agent_update') {
        setAgents(prev => prev.map((a, i) =>
          i === event.agent_index
            ? { ...a, status: event.status, message: event.message, preview: event.preview }
            : a
        ));
      } else if (event.type === 'state') {
        setJobStatus(event.status);
        if (event.agents) {
          setAgents(prev => event.agents.map((a, i) => ({ ...(prev[i] || {}), ...a })));
        }
      } else if (event.type === 'completed') {
        setJobStatus('completed');
        setResult(event.graph);
        if (event.graph?.schema_evolution?.length) {
          setSchemaEvolution(event.graph.schema_evolution);
        }
        if (event.graph?.memory_applied?.length) {
          setMemoryApplied(event.graph.memory_applied);
        }
        if (event.graph && (event.graph.nodes?.length || 0) > 0) {
          dispatch({ type: 'LOAD_GRAPH', payload: event.graph });
        }
        ws.close();
      } else if (event.type === 'error') {
        setError(event.message);
        setJobStatus('failed');
        ws.close();
      }
    };

    ws.onerror = () => {
      setError('WebSocket 연결 오류');
      setJobStatus('failed');
    };

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 20000);
    ws.onclose = () => clearInterval(ping);
  }, [dispatch, fetchMemoryPatterns]);

  const reset = useCallback(() => {
    wsRef.current?.close();
    setAgents(INITIAL_AGENTS.map(a => ({ ...a })));
    setJobStatus('idle');
    setError(null);
    setResult(null);
    setSchemaEvolution([]);
    setMemoryApplied([]);
  }, []);

  const applyResult = useCallback(() => {
    if (result) dispatch({ type: 'LOAD_GRAPH', payload: result });
  }, [result, dispatch]);

  return {
    agents, jobStatus, backendOnline, error, result,
    schemaEvolution, memoryApplied, memoryPatterns,
    startJob, reset, applyResult, checkBackend,
    fetchMemoryPatterns, saveMemoryPattern, deleteMemoryPattern,
    totalAgents: TOTAL_AGENTS,
  };
}

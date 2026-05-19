import { useState, useRef, useCallback, useContext } from 'react';
import GraphContext from '../context/GraphContext';

const BACKEND = 'http://localhost:8000';

const INITIAL_AGENTS = [
  { name: 'Research Agent',    emoji: '🔍', status: 'pending', message: '', preview: '' },
  { name: 'Extraction Agent',  emoji: '🧠', status: 'pending', message: '', preview: '' },
  { name: 'Relation Agent',    emoji: '🔗', status: 'pending', message: '', preview: '' },
  { name: 'Validation Agent',  emoji: '✅', status: 'pending', message: '', preview: '' },
  { name: 'Editor Agent',      emoji: '✏️', status: 'pending', message: '', preview: '' },
];

export function useCrewAI() {
  const { dispatch } = useContext(GraphContext);
  const [agents, setAgents]       = useState(INITIAL_AGENTS);
  const [jobStatus, setJobStatus] = useState('idle'); // idle | running | completed | failed
  const [backendOnline, setBackendOnline] = useState(null); // null=unknown, true/false
  const [error, setError]         = useState(null);
  const [result, setResult]       = useState(null);
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

  const startJob = useCallback(async (topic, options = {}) => {
    setAgents(INITIAL_AGENTS.map(a => ({ ...a })));
    setJobStatus('running');
    setError(null);
    setResult(null);

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

    // Connect WebSocket
    const ws = new WebSocket(`ws://localhost:8000/ws/crew/${jobId}`);
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
          setAgents(prev => event.agents.map((a, i) => ({ ...prev[i], ...a })));
        }
      } else if (event.type === 'completed') {
        setJobStatus('completed');
        setResult(event.graph);
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

    // Keep-alive ping every 20s
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 20000);
    ws.onclose = () => clearInterval(ping);
  }, [dispatch]);

  const reset = useCallback(() => {
    wsRef.current?.close();
    setAgents(INITIAL_AGENTS.map(a => ({ ...a })));
    setJobStatus('idle');
    setError(null);
    setResult(null);
  }, []);

  const applyResult = useCallback(() => {
    if (result) dispatch({ type: 'LOAD_GRAPH', payload: result });
  }, [result, dispatch]);

  return { agents, jobStatus, backendOnline, error, result, startJob, reset, applyResult, checkBackend };
}

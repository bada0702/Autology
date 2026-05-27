import React, { useContext, useRef, useState, useEffect, useCallback } from 'react';
import GraphContext from '../../context/GraphContext';
import Node from '../Nodes/Node';
import Edge from '../Edges/Edge';
import { NODE_W, NODE_H } from '../../constants/nodeTypes';
import './Canvas.css';

export default function Canvas() {
  const { state, dispatch } = useContext(GraphContext);
  const canvasRef    = useRef(null);
  const isPanning    = useRef(false);
  const lastMouse    = useRef({ x: 0, y: 0 });
  const clipboard    = useRef(null); // copied node
  const [ghostPos, setGhostPos]   = useState(null);
  const [hoverNode, setHoverNode] = useState(null); // unused – done via dispatch

  // ── Keyboard shortcuts ────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
      switch (e.key) {
        case 'Delete':
        case 'Backspace': {
          if (!state.selectedId) return;
          const isNode = state.nodes.some(n => n.id === state.selectedId);
          dispatch({ type: isNode ? 'DELETE_NODE' : 'DELETE_EDGE', payload: state.selectedId });
          break;
        }
        case 'z':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); dispatch({ type: 'UNDO' }); }
          break;
        case 'y':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); dispatch({ type: 'REDO' }); }
          break;
        case 'Escape':
          if (state.mode === 'connecting') dispatch({ type: 'STOP_CONNECTING' });
          dispatch({ type: 'SET_SELECTED', payload: null });
          break;
        case 'c':
          if ((e.ctrlKey || e.metaKey) && state.selectedId) {
            const n = state.nodes.find(x => x.id === state.selectedId);
            if (n) { clipboard.current = n; }
          } else if (!e.ctrlKey && !e.metaKey) {
            dispatch({ type: 'SET_MODE', payload: 'select' });
          }
          break;
        case 'v':
          if (e.ctrlKey || e.metaKey) {
            if (clipboard.current) {
              const src = clipboard.current;
              dispatch({
                type: 'ADD_NODE',
                payload: {
                  ...src,
                  id: `node_${Date.now()}`,
                  x: src.x + 32,
                  y: src.y + 32,
                },
              });
            }
          } else {
            dispatch({ type: 'SET_MODE', payload: 'select' });
          }
          break;
        case 'h': dispatch({ type: 'SET_MODE', payload: 'panning' }); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.selectedId, state.mode, state.nodes, dispatch]);

  // ── Ghost edge tracking (window-level while connecting) ──
  useEffect(() => {
    if (state.mode !== 'connecting') { setGhostPos(null); return; }
    const onMove = (e) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setGhostPos({
        x: (e.clientX - rect.left - state.pan.x) / state.zoom,
        y: (e.clientY - rect.top  - state.pan.y) / state.zoom,
      });
    };
    const onUp = () => {
      dispatch({ type: 'STOP_CONNECTING' });
      setGhostPos(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [state.mode, state.pan, state.zoom, dispatch]);

  // ── Canvas mouse handlers ─────────────────────────────────
  const toWorld = useCallback((cx, cy) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (cx - rect.left - state.pan.x) / state.zoom,
      y: (cy - rect.top  - state.pan.y) / state.zoom,
    };
  }, [state.pan, state.zoom]);

  const handleMouseDown = (e) => {
    if (state.mode === 'connecting') return;
    const isBackground =
      e.target === canvasRef.current ||
      e.target.id === 'svg-layer'     ||
      e.target.classList.contains('canvas-world');

    if (isBackground) {
      dispatch({ type: 'SET_SELECTED', payload: null });
    }

    if (e.button === 1 || state.mode === 'panning' || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      isPanning.current = true;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      canvasRef.current.style.cursor = 'grabbing';
    }
  };

  const handleMouseMove = (e) => {
    if (isPanning.current) {
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      dispatch({ type: 'SET_PAN', payload: { x: state.pan.x + dx, y: state.pan.y + dy } });
      lastMouse.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseUp = () => {
    isPanning.current = false;
    canvasRef.current.style.cursor = state.mode === 'panning' ? 'grab' : 'default';
  };

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      const newZoom = Math.min(Math.max(state.zoom * factor, 0.15), 4);
      const rect = canvasRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const newPanX = mx - (mx - state.pan.x) * (newZoom / state.zoom);
      const newPanY = my - (my - state.pan.y) * (newZoom / state.zoom);
      dispatch({ type: 'SET_ZOOM', payload: newZoom });
      dispatch({ type: 'SET_PAN', payload: { x: newPanX, y: newPanY } });
    } else {
      dispatch({ type: 'SET_PAN', payload: { x: state.pan.x - e.deltaX, y: state.pan.y - e.deltaY } });
    }
  }, [state.zoom, state.pan, dispatch]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const handleDoubleClick = (e) => {
    const isBackground =
      e.target === canvasRef.current ||
      e.target.id === 'svg-layer'     ||
      e.target.classList.contains('canvas-world');
    if (!isBackground) return;

    const { x, y } = toWorld(e.clientX, e.clientY);
    const defaultCount = state.nodes.filter(n => /^new concept(\s+\d+)?$/i.test(n.label)).length;
    const newLabel = defaultCount === 0 ? 'New Concept' : `New Concept ${defaultCount + 1}`;
    dispatch({
      type: 'ADD_NODE',
      payload: {
        id: `node_${Date.now()}`,
        label: newLabel,
        type: 'Class',
        x: x - NODE_W / 2,
        y: y - NODE_H / 2,
        properties: [],
        description: ''
      }
    });
  };

  // Ghost edge source node
  const ghostSrc = state.connectingSource
    ? state.nodes.find(n => n.id === state.connectingSource)
    : null;

  return (
    <div
      ref={canvasRef}
      className={`canvas-root${state.mode === 'panning' ? ' canvas-root--pan' : ''}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className="canvas-world"
        style={{ transform: `translate(${state.pan.x}px,${state.pan.y}px) scale(${state.zoom})`, transformOrigin: '0 0' }}
      >
        <svg id="svg-layer" className="svg-layer">
          <defs>
            {/* End markers (→) */}
            <marker id="arrow-default"  markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
              <polygon points="0 0,8 3,0 6" fill="rgba(255,255,255,0.25)" />
            </marker>
            <marker id="arrow-selected" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
              <polygon points="0 0,8 3,0 6" fill="#818cf8" />
            </marker>
            <marker id="arrow-inferred" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
              <polygon points="0 0,8 3,0 6" fill="#a78bfa" />
            </marker>
            {/* Start markers for bidirectional (←) */}
            <marker id="arrow-start-default"  markerWidth="8" markerHeight="6" refX="1" refY="3" orient="auto-start-reverse">
              <polygon points="0 0,8 3,0 6" fill="rgba(255,255,255,0.25)" />
            </marker>
            <marker id="arrow-start-selected" markerWidth="8" markerHeight="6" refX="1" refY="3" orient="auto-start-reverse">
              <polygon points="0 0,8 3,0 6" fill="#818cf8" />
            </marker>
            <marker id="arrow-start-inferred" markerWidth="8" markerHeight="6" refX="1" refY="3" orient="auto-start-reverse">
              <polygon points="0 0,8 3,0 6" fill="#a78bfa" />
            </marker>
          </defs>

          {state.edges.map(edge => <Edge key={edge.id} edge={edge} />)}

          {/* Ghost edge while connecting */}
          {ghostSrc && ghostPos && (
            <line
              x1={ghostSrc.x + NODE_W / 2}
              y1={ghostSrc.y + NODE_H / 2}
              x2={ghostPos.x}
              y2={ghostPos.y}
              stroke="#818cf8"
              strokeWidth={2}
              strokeDasharray="7 4"
              opacity={0.7}
              pointerEvents="none"
            />
          )}
        </svg>

        <div className="nodes-layer">
          {state.nodes.map(node => <Node key={node.id} node={node} />)}
        </div>
      </div>

      {/* Empty state guide */}
      {state.nodes.length === 0 && (
        <div className="canvas-empty">
          <div className="canvas-empty-icon">⬡</div>
          <p className="canvas-empty-title">캔버스가 비어 있습니다</p>
          <p className="canvas-empty-subtitle">아래 방법 중 하나로 시작하세요</p>
          <ul className="canvas-empty-steps">
            <li><span className="canvas-empty-key">더블클릭</span> 빈 곳을 더블클릭해서 노드 직접 추가</li>
            <li><span className="canvas-empty-key">+</span> 상단 툴바 노드 추가 버튼으로 생성</li>
            <li><span className="canvas-empty-key">AI</span> 오른쪽 상단 AI 생성으로 자동 구성</li>
            <li><span className="canvas-empty-key">JSON</span> 저장된 파일을 불러와서 이어 작업</li>
          </ul>
        </div>
      )}

      {/* Status bar */}
      <div className="canvas-statusbar">
        <span>{Math.round(state.zoom * 100)}%</span>
        <span className="canvas-status-sep">·</span>
        <span>{state.nodes.length} nodes · {state.edges.length} edges</span>
        <span className="canvas-status-sep">·</span>
        <span className="canvas-mode">{state.mode.toUpperCase()}</span>
        {state.mode === 'connecting' && <span className="canvas-hint">포트에 드롭하여 연결</span>}
        {state.mode === 'select' && <span className="canvas-hint">더블클릭으로 노드 추가</span>}
      </div>
    </div>
  );
}

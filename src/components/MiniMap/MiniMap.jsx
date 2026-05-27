import React, { useContext, useMemo, useRef, useEffect, useState } from 'react';
import GraphContext from '../../context/GraphContext';
import { NODE_COLORS, NODE_W, NODE_H } from '../../constants/nodeTypes';
import './MiniMap.css';

const MAP_W = 160;
const MAP_H = 100;
const PAD   = 10;

export default function MiniMap() {
  const { state } = useContext(GraphContext);
  const [canvasSize, setCanvasSize] = useState({ w: 900, h: 600 });

  // Track canvas-area dimensions for the viewport rectangle
  useEffect(() => {
    const el = document.querySelector('.canvas-area');
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setCanvasSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const extent = useMemo(() => {
    if (state.nodes.length === 0) return null;
    const xs = state.nodes.map(n => n.x);
    const ys = state.nodes.map(n => n.y);
    return {
      minX: Math.min(...xs) - PAD,
      minY: Math.min(...ys) - PAD,
      maxX: Math.max(...xs) + NODE_W + PAD,
      maxY: Math.max(...ys) + NODE_H + PAD,
    };
  }, [state.nodes]);

  if (!extent) return null;

  const worldW  = Math.max(extent.maxX - extent.minX, 1);
  const worldH  = Math.max(extent.maxY - extent.minY, 1);
  const innerW  = MAP_W - PAD * 2;
  const innerH  = MAP_H - PAD * 2;
  const scale   = Math.min(innerW / worldW, innerH / worldH);
  const ox      = PAD + (innerW - worldW * scale) / 2;
  const oy      = PAD + (innerH - worldH * scale) / 2;

  const toMap = (wx, wy) => ({
    x: ox + (wx - extent.minX) * scale,
    y: oy + (wy - extent.minY) * scale,
  });

  // Viewport rectangle in world coords
  const vpX  = -state.pan.x / state.zoom;
  const vpY  = -state.pan.y / state.zoom;
  const vpW  = canvasSize.w / state.zoom;
  const vpH  = canvasSize.h / state.zoom;

  const vp = toMap(vpX, vpY);
  const vpMapW = vpW * scale;
  const vpMapH = vpH * scale;

  return (
    <div className="minimap glass">
      <svg width={MAP_W} height={MAP_H}>
        {/* Edges */}
        {state.edges.map(edge => {
          const s = state.nodes.find(n => n.id === edge.source);
          const t = state.nodes.find(n => n.id === edge.target);
          if (!s || !t) return null;
          const p1 = toMap(s.x + NODE_W / 2, s.y + NODE_H / 2);
          const p2 = toMap(t.x + NODE_W / 2, t.y + NODE_H / 2);
          return (
            <line key={edge.id}
              x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
              stroke={edge.inferred ? 'rgba(167,139,250,0.25)' : 'rgba(255,255,255,0.1)'}
              strokeWidth={1}
              strokeDasharray={edge.inferred ? '3 2' : 'none'}
            />
          );
        })}

        {/* Nodes */}
        {state.nodes.map(node => {
          const p  = toMap(node.x, node.y);
          const nw = Math.max(NODE_W * scale, 4);
          const nh = Math.max(NODE_H * scale, 3);
          const c  = NODE_COLORS[node.type] || '#818cf8';
          const isSel = state.selectedId === node.id;
          return (
            <rect key={node.id}
              x={p.x} y={p.y}
              width={nw} height={nh}
              rx={2}
              fill={c}
              fillOpacity={isSel ? 0.95 : 0.5}
              stroke={isSel ? c : 'none'}
              strokeWidth={isSel ? 1 : 0}
            />
          );
        })}

        {/* Viewport indicator */}
        <rect
          x={vp.x} y={vp.y}
          width={Math.max(vpMapW, 8)}
          height={Math.max(vpMapH, 6)}
          fill="rgba(129,140,248,0.08)"
          stroke="rgba(129,140,248,0.45)"
          strokeWidth={1}
          rx={2}
        />
      </svg>
    </div>
  );
}

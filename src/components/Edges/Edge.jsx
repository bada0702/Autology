import React, { useContext, useState, useRef } from 'react';
import GraphContext from '../../context/GraphContext';
import { NODE_COLORS, NODE_W, NODE_H } from '../../constants/nodeTypes';
import './Edge.css';

// Compute point on node rectangle boundary toward a target
function borderPoint(node, tx, ty) {
  const cx = node.x + NODE_W / 2;
  const cy = node.y + NODE_H / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return { x: cx, y: cy };

  const hw = NODE_W / 2 + 2;
  const hh = NODE_H / 2 + 2;
  const sx = hw / Math.abs(dx);
  const sy = hh / Math.abs(dy);
  const s  = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

function buildPath(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const cx1 = x1 + dx * 0.5;
  const cy1 = y1 + dy * 0.05;
  const cx2 = x2 - dx * 0.5;
  const cy2 = y2 - dy * 0.05;
  return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
}

const Edge = ({ edge }) => {
  const { state, dispatch } = useContext(GraphContext);
  const [editing, setEditing] = useState(false);
  const [labelValue, setLabelValue] = useState(edge.label);
  const inputRef = useRef(null);

  const src = state.nodes.find(n => n.id === edge.source);
  const tgt = state.nodes.find(n => n.id === edge.target);
  if (!src || !tgt) return null;

  const isSelected = state.selectedId === edge.id;
  const hasHighlight = state.highlightedIds.length > 0;
  const isPathEdge = state.highlightedEdgeIds.includes(edge.id);
  const isEdgeDimmed = hasHighlight && !isPathEdge;
  const tgtCx = tgt.x + NODE_W / 2;
  const tgtCy = tgt.y + NODE_H / 2;
  const srcCx = src.x + NODE_W / 2;
  const srcCy = src.y + NODE_H / 2;

  const p1 = borderPoint(src, tgtCx, tgtCy);
  const p2 = borderPoint(tgt, srcCx, srcCy);
  const path = buildPath(p1.x, p1.y, p2.x, p2.y);

  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;

  const strokeColor = isPathEdge
    ? '#fbbf24'
    : edge.inferred ? '#a78bfa' : (isSelected ? '#818cf8' : 'rgba(255,255,255,0.25)');
  const strokeDash  = edge.inferred ? '7 4' : 'none';
  const strokeW     = isPathEdge ? 2.8 : (isSelected ? 2.5 : 1.8);
  const edgeOpacity = isEdgeDimmed ? 0.12 : 1;

  const handleEdgeClick = (e) => {
    e.stopPropagation();
    dispatch({ type: 'SET_SELECTED', payload: edge.id });
  };

  const handleLabelClick = (e) => {
    e.stopPropagation();
    dispatch({ type: 'SET_SELECTED', payload: edge.id });
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 10);
  };

  const commitLabel = () => {
    setEditing(false);
    dispatch({ type: 'UPDATE_EDGE', payload: { id: edge.id, updates: { label: labelValue } } });
  };

  const handleLabelKey = (e) => {
    if (e.key === 'Enter') commitLabel();
    if (e.key === 'Escape') {
      setEditing(false);
      setLabelValue(edge.label);
    }
  };

  const isBidi = edge.direction === 'both';
  const markerEndId   = edge.inferred ? 'arrow-inferred' : (isSelected ? 'arrow-selected' : 'arrow-default');
  const markerStartId = edge.inferred ? 'arrow-start-inferred' : (isSelected ? 'arrow-start-selected' : 'arrow-start-default');

  return (
    <g className={`edge-g${isSelected ? ' edge-g--selected' : ''}`} onClick={handleEdgeClick} style={{ opacity: edgeOpacity }}>
      {/* Wider invisible hit area */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={16} style={{ cursor: 'pointer' }} />

      {/* Visible edge */}
      <path
        d={path}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeW}
        strokeDasharray={strokeDash}
        markerEnd={`url(#${markerEndId})`}
        markerStart={isBidi ? `url(#${markerStartId})` : undefined}
        className="edge-path"
      />

      {/* Label */}
      <g transform={`translate(${midX}, ${midY})`} className="edge-label-g">
        {editing ? (
          <foreignObject x={-55} y={-12} width={110} height={24}>
            <input
              ref={inputRef}
              className="edge-label-input"
              value={labelValue}
              onChange={e => setLabelValue(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={handleLabelKey}
            />
          </foreignObject>
        ) : (
          <g onClick={handleLabelClick} style={{ cursor: 'text' }}>
            <rect
              x={-Math.max(labelValue.length * 4 + 12, 30) / 2}
              y={-9}
              width={Math.max(labelValue.length * 4 + 12, 30)}
              height={18}
              rx={5}
              fill="rgba(9,9,15,0.85)"
              stroke={isSelected ? '#818cf8' : 'rgba(255,255,255,0.1)'}
              strokeWidth={1}
            />
            <text
              textAnchor="middle"
              dy="0.35em"
              fill={isSelected ? '#818cf8' : 'rgba(255,255,255,0.5)'}
              fontSize={10}
              fontFamily="Inter, system-ui, sans-serif"
              fontWeight={500}
            >
              {labelValue || (isSelected ? 'click to label' : '')}
            </text>
          </g>
        )}
      </g>

      {/* Inferred lightning badge */}
      {edge.inferred && (
        <text x={midX + 28} y={midY + 4} fontSize={11} fill="#a78bfa">⚡</text>
      )}
    </g>
  );
};

export default Edge;

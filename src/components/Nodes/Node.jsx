import React, { useContext } from 'react';
import GraphContext from '../../context/GraphContext';
import { NODE_COLORS, NODE_BG } from '../../constants/nodeTypes';
import './Node.css';

// Deterministic color from source filename
const SOURCE_PALETTE = [
  '#f59e0b','#34d399','#f472b6','#60a5fa',
  '#a78bfa','#fb923c','#22d3ee','#e879f9',
];
function sourceColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SOURCE_PALETTE[h % SOURCE_PALETTE.length];
}

const Node = ({ node }) => {
  const { state, dispatch } = useContext(GraphContext);
  const isSelected   = state.selectedId === node.id;
  const isConnSrc    = state.connectingSource === node.id;
  const isConnTarget = state.connectingTarget === node.id;
  const isConnecting = state.mode === 'connecting';
  const hasHighlight = state.highlightedIds.length > 0;
  const isHighlighted = hasHighlight && state.highlightedIds.includes(node.id);
  const isDimmed     = hasHighlight && !isHighlighted;

  const color = NODE_COLORS[node.type] || '#818cf8';
  const bg    = NODE_BG[node.type]    || 'rgba(129,140,248,0.12)';

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    if (isConnecting) return;
    e.stopPropagation();
    dispatch({ type: 'SET_SELECTED', payload: node.id });

    const startX = e.clientX;
    const startY = e.clientY;
    const origX  = node.x;
    const origY  = node.y;
    let moved = false;

    const onMove = (mv) => {
      const dx = (mv.clientX - startX) / state.zoom;
      const dy = (mv.clientY - startY) / state.zoom;
      if (!moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) moved = true;
      dispatch({ type: 'MOVE_NODE', payload: { id: node.id, x: origX + dx, y: origY + dy } });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handlePortMouseDown = (e) => {
    e.stopPropagation();
    e.preventDefault();
    dispatch({ type: 'START_CONNECTING', payload: node.id });
  };

  const handleMouseEnter = () => {
    if (isConnecting && !isConnSrc) {
      dispatch({ type: 'SET_CONNECTING_TARGET', payload: node.id });
    }
  };

  const handleMouseLeave = () => {
    if (isConnecting) {
      dispatch({ type: 'SET_CONNECTING_TARGET', payload: null });
    }
  };

  const handleMouseUp = (e) => {
    if (isConnecting && state.connectingTarget === node.id) {
      e.stopPropagation();
      dispatch({ type: 'COMPLETE_CONNECTION' });
    }
  };

  const srcColor = node._source ? sourceColor(node._source) : null;

  // Detect if hovering a same-label node during connection (will merge, not link)
  const connSrcNode = isConnTarget
    ? state.nodes.find(n => n.id === state.connectingSource)
    : null;
  const willMerge = connSrcNode
    ? connSrcNode.label.toLowerCase().trim() === node.label.toLowerCase().trim()
    : false;

  return (
    <div
      className={[
        'node',
        isSelected    ? 'node--selected'  : '',
        isConnSrc     ? 'node--conn-src'  : '',
        isConnTarget  ? (willMerge ? 'node--merge-tgt' : 'node--conn-tgt') : '',
        isConnecting && !isConnSrc ? 'node--connectable' : '',
        isHighlighted ? 'node--highlighted' : '',
        isDimmed      ? 'node--dimmed'    : '',
      ].join(' ')}
      style={{ left: node.x, top: node.y, '--node-color': color, '--node-bg': bg }}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseUp={handleMouseUp}
    >
      {/* Top accent stripe — source color overrides node type color */}
      <div className="node-stripe" style={srcColor ? { background: srcColor } : undefined} />

      <div className="node-body">
        <span className="node-label">{node.label}</span>
        <span className="node-type-badge">{node.type}</span>
      </div>

      {willMerge && (
        <div className="node-merge-hint">병합됩니다</div>
      )}

      {node._source && (
        <div className="node-source-badge" style={{ background: srcColor + '22', color: srcColor, borderColor: srcColor + '55' }}>
          {node._source}
        </div>
      )}

      {node.properties?.length > 0 && (
        <div className="node-props">
          {node.properties.slice(0, 3).map((p, i) => (
            <div key={i} className="node-prop">
              <span className="node-prop-key">{p.key}</span>
              <span className="node-prop-val">{p.value}</span>
            </div>
          ))}
          {node.properties.length > 3 && (
            <span className="node-prop-more">+{node.properties.length - 3} more</span>
          )}
        </div>
      )}

      {/* Ports – appear on hover */}
      <div className="port port-top"    onMouseDown={handlePortMouseDown} />
      <div className="port port-right"  onMouseDown={handlePortMouseDown} />
      <div className="port port-bottom" onMouseDown={handlePortMouseDown} />
      <div className="port port-left"   onMouseDown={handlePortMouseDown} />
    </div>
  );
};

export default Node;

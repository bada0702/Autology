import React, { createContext, useReducer } from 'react';

const GraphContext = createContext();

const initialState = {
  nodes: [],
  edges: [],
  selectedId: null,
  mode: 'select',             // select | panning | connecting
  connectingSource: null,     // nodeId when dragging edge from port
  connectingTarget: null,     // nodeId currently hovered during connection
  history: [{ nodes: [], edges: [] }],
  historyIndex: 0,
  pan: { x: 0, y: 0 },
  zoom: 1,
  highlightedIds: [],         // node ids to highlight (search/path results)
  highlightedEdgeIds: [],     // edge ids to highlight (path results)
  snapshots: [],              // [{ id, name, timestamp, nodes, edges }]
};

function addHistory(state, next) {
  const hist = state.history.slice(0, state.historyIndex + 1);
  hist.push({ nodes: next.nodes, edges: next.edges });
  if (hist.length > 60) hist.shift();
  return { ...next, history: hist, historyIndex: hist.length - 1 };
}

function graphReducer(state, action) {
  let next;
  switch (action.type) {

    case 'SET_MODE':
      return { ...state, mode: action.payload };

    case 'SET_SELECTED':
      return { ...state, selectedId: action.payload };

    case 'SET_PAN':
      return { ...state, pan: action.payload };

    case 'SET_ZOOM':
      return { ...state, zoom: action.payload };

    // ── Node operations ───────────────────────────────────
    case 'ADD_NODE':
      next = { ...state, nodes: [...state.nodes, action.payload], selectedId: action.payload.id };
      return addHistory(state, next);

    case 'MOVE_NODE':
      return {
        ...state,
        nodes: state.nodes.map(n =>
          n.id === action.payload.id ? { ...n, x: action.payload.x, y: action.payload.y } : n
        )
      };

    case 'UPDATE_NODE':
      next = {
        ...state,
        nodes: state.nodes.map(n =>
          n.id === action.payload.id ? { ...n, ...action.payload.updates } : n
        )
      };
      return addHistory(state, next);

    case 'DELETE_NODE':
      next = {
        ...state,
        nodes: state.nodes.filter(n => n.id !== action.payload),
        edges: state.edges.filter(e => e.source !== action.payload && e.target !== action.payload),
        selectedId: state.selectedId === action.payload ? null : state.selectedId
      };
      return addHistory(state, next);

    // ── Edge operations ───────────────────────────────────
    case 'ADD_EDGE': {
      const dup = state.edges.find(e => !e.inferred && e.source === action.payload.source && e.target === action.payload.target);
      if (dup) return state;
      // Remove existing inferred edge with same direction when adding a real edge
      const baseEdges = action.payload.inferred
        ? state.edges
        : state.edges.filter(e => !(e.inferred && e.source === action.payload.source && e.target === action.payload.target));
      next = { ...state, edges: [...baseEdges, action.payload], selectedId: action.payload.id };
      return addHistory(state, next);
    }

    case 'UPDATE_EDGE':
      next = {
        ...state,
        edges: state.edges.map(e =>
          e.id === action.payload.id ? { ...e, ...action.payload.updates } : e
        )
      };
      return addHistory(state, next);

    case 'DELETE_EDGE':
      next = {
        ...state,
        edges: state.edges.filter(e => e.id !== action.payload),
        selectedId: state.selectedId === action.payload ? null : state.selectedId
      };
      return addHistory(state, next);

    // ── Edge connection ────────────────────────────────────
    case 'START_CONNECTING':
      return { ...state, mode: 'connecting', connectingSource: action.payload, connectingTarget: null };

    case 'SET_CONNECTING_TARGET':
      return { ...state, connectingTarget: action.payload };

    case 'COMPLETE_CONNECTION': {
      const { connectingSource: src, connectingTarget: tgt } = state;
      if (!src || !tgt || src === tgt) {
        return { ...state, mode: 'select', connectingSource: null, connectingTarget: null };
      }

      const srcNode = state.nodes.find(n => n.id === src);
      const tgtNode = state.nodes.find(n => n.id === tgt);

      // Same label → merge src into tgt instead of creating an edge
      // Skip merge if either node still has a default generated label
      const isDefault = (label) => /^new concept(\s+\d+)?$/i.test(label.trim());
      if (
        srcNode && tgtNode &&
        !isDefault(srcNode.label) &&
        !isDefault(tgtNode.label) &&
        srcNode.label.toLowerCase().trim() === tgtNode.label.toLowerCase().trim()
      ) {
        const seenKeys = new Set(
          state.edges
            .filter(e => !e.inferred && e.source !== src && e.target !== src)
            .map(e => `${e.source}||${e.target}`)
        );
        const redirected = state.edges
          .filter(e => !e.inferred)
          .map(e => ({
            ...e,
            source: e.source === src ? tgt : e.source,
            target: e.target === src ? tgt : e.target,
          }))
          .filter(e => {
            if (e.source === e.target) return false;
            const k = `${e.source}||${e.target}`;
            if (seenKeys.has(k)) return false;
            seenKeys.add(k);
            return true;
          });
        next = {
          ...state,
          nodes: state.nodes.filter(n => n.id !== src),
          edges: [...redirected, ...state.edges.filter(e => e.inferred)],
          mode: 'select',
          connectingSource: null,
          connectingTarget: null,
          selectedId: tgt,
        };
        return addHistory(state, next);
      }

      const exists = state.edges.find(e => e.source === src && e.target === tgt);
      if (exists) return { ...state, mode: 'select', connectingSource: null, connectingTarget: null };
      const newEdge = { id: `edge_${Date.now()}`, source: src, target: tgt, label: '', style: 'solid', inferred: false };
      next = {
        ...state,
        edges: [...state.edges, newEdge],
        mode: 'select',
        connectingSource: null,
        connectingTarget: null,
        selectedId: newEdge.id
      };
      return addHistory(state, next);
    }

    case 'STOP_CONNECTING':
      return { ...state, mode: 'select', connectingSource: null, connectingTarget: null };

    // ── History ────────────────────────────────────────────
    case 'UNDO':
      if (state.historyIndex > 0) {
        const prev = state.history[state.historyIndex - 1];
        return { ...state, nodes: prev.nodes, edges: prev.edges, historyIndex: state.historyIndex - 1 };
      }
      return state;

    case 'REDO':
      if (state.historyIndex < state.history.length - 1) {
        const fwd = state.history[state.historyIndex + 1];
        return { ...state, nodes: fwd.nodes, edges: fwd.edges, historyIndex: state.historyIndex + 1 };
      }
      return state;

    // ── Graph load ─────────────────────────────────────────
    case 'LOAD_GRAPH': {
      const nodes = (action.payload.nodes || []).map((n, i) => ({
        id: n.id || `node_${Date.now()}_${i}`,
        label: n.label || 'Node',
        type: n.type || 'Class',
        x: n.x ?? (i % 4) * 200 + 100,
        y: n.y ?? Math.floor(i / 4) * 160 + 100,
        properties: n.properties || [],
        description: n.description || ''
      }));
      const edges = (action.payload.edges || []).map((e, i) => ({
        id: e.id || `edge_${Date.now()}_${i}`,
        source: e.source,
        target: e.target,
        label: e.label || '',
        style: e.style || 'solid',
        inferred: !!e.inferred
      }));
      next = { ...state, nodes, edges, selectedId: null };
      return { ...next, history: [{ nodes, edges }], historyIndex: 0 };
    }

    case 'MERGE_GRAPH': {
      const { nodes: inNodes = [], edges: inEdges = [], sourceName = 'Unknown' } = action.payload;

      // Place incoming graph to the right of the existing bounding box
      let maxX = 0;
      for (const n of state.nodes) {
        const nx = (n.x || 0) + 220;
        if (nx > maxX) maxX = nx;
      }
      const offsetX = state.nodes.length > 0 ? maxX + 140 : 0;

      // Dedup by label only (case-insensitive, trimmed) — cross-type merges are intentional
      const existingByKey = new Map();
      for (const n of state.nodes) {
        existingByKey.set(n.label.toLowerCase().trim(), n.id);
      }

      const idMap = {};
      const newNodes = [];
      const tsBase = Date.now();
      let serial = 0;

      for (const n of inNodes) {
        const key = n.label.toLowerCase().trim();
        if (existingByKey.has(key)) {
          idMap[n.id] = existingByKey.get(key);
        } else {
          const newId = `node_${tsBase}_${serial++}`;
          idMap[n.id] = newId;
          existingByKey.set(key, newId);
          newNodes.push({
            ...n,
            id: newId,
            x: (n.x ?? 0) + offsetX,
            y: n.y ?? 0,
            _source: sourceName,
            properties: n.properties || [],
            description: n.description || '',
          });
        }
      }

      const existingEdgeKeys = new Set(
        state.edges.filter(e => !e.inferred)
          .map(e => `${e.source}|${e.target}|${e.label || ''}`)
      );
      const newEdges = [];
      for (const e of inEdges) {
        const src = idMap[e.source];
        const tgt = idMap[e.target];
        if (!src || !tgt || src === tgt) continue;
        const key = `${src}|${tgt}|${e.label || ''}`;
        if (existingEdgeKeys.has(key)) continue;
        existingEdgeKeys.add(key);
        newEdges.push({
          ...e,
          id: `edge_${tsBase}_${serial++}`,
          source: src,
          target: tgt,
          style: e.style || 'solid',
          inferred: false,
        });
      }

      next = {
        ...state,
        nodes: [...state.nodes, ...newNodes],
        edges: [...state.edges, ...newEdges],
        selectedId: null,
      };
      return addHistory(state, next);
    }

    case 'RESET_GRAPH':
      return { ...initialState, history: [{ nodes: [], edges: [] }], historyIndex: 0 };

    // ── Layout ────────────────────────────────────────────
    case 'APPLY_LAYOUT': {
      // payload: { [nodeId]: { x, y } }
      next = {
        ...state,
        nodes: state.nodes.map(n =>
          action.payload[n.id]
            ? { ...n, x: action.payload[n.id].x, y: action.payload[n.id].y }
            : n
        ),
      };
      return addHistory(state, next);
    }

    // ── Entity normalization ───────────────────────────────
    case 'ACCEPT_MERGE': {
      // Merge sourceId node into targetId: redirect edges, delete source
      const { sourceId, targetId } = action.payload;
      const existingKeys = new Set(
        state.edges
          .filter(e => !e.inferred && e.source !== sourceId && e.target !== sourceId)
          .map(e => `${e.source}||${e.target}`)
      );
      const redirected = state.edges
        .filter(e => !e.inferred)
        .map(e => {
          const src = e.source === sourceId ? targetId : e.source;
          const tgt = e.target === sourceId ? targetId : e.target;
          return { ...e, source: src, target: tgt };
        })
        .filter(e => {
          if (e.source === e.target) return false; // no self-loop
          const k = `${e.source}||${e.target}`;
          if (existingKeys.has(k)) return false;
          existingKeys.add(k);
          return true;
        });
      next = {
        ...state,
        nodes: state.nodes.filter(n => n.id !== sourceId),
        edges: [...redirected, ...state.edges.filter(e => e.inferred)],
        selectedId: state.selectedId === sourceId ? null : state.selectedId,
      };
      return addHistory(state, next);
    }

    case 'NORMALIZE_LABELS': {
      // payload: { [nodeId]: newLabel }
      next = {
        ...state,
        nodes: state.nodes.map(n =>
          action.payload[n.id] !== undefined
            ? { ...n, label: action.payload[n.id] }
            : n
        ),
      };
      return addHistory(state, next);
    }

    // ── Rule engine ────────────────────────────────────────
    case 'APPLY_RULES': {
      const direct = state.edges.filter(e => !e.inferred);
      return { ...state, edges: [...direct, ...action.payload] };
    }

    case 'CLEAR_INFERRED':
      return { ...state, edges: state.edges.filter(e => !e.inferred) };

    // ── Highlight (search / path) ──────────────────────────
    case 'SET_HIGHLIGHT':
      return {
        ...state,
        highlightedIds: action.payload.nodeIds || [],
        highlightedEdgeIds: action.payload.edgeIds || [],
      };

    case 'CLEAR_HIGHLIGHT':
      return { ...state, highlightedIds: [], highlightedEdgeIds: [] };

    // ── Snapshots ──────────────────────────────────────────
    case 'TAKE_SNAPSHOT': {
      const snap = {
        id: `snap_${Date.now()}`,
        name: action.payload || `스냅샷 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`,
        timestamp: Date.now(),
        nodes: state.nodes,
        edges: state.edges.filter(e => !e.inferred),
      };
      const snapshots = [...state.snapshots, snap].slice(-20); // keep last 20
      return { ...state, snapshots };
    }

    case 'RESTORE_SNAPSHOT': {
      const snap = state.snapshots.find(s => s.id === action.payload);
      if (!snap) return state;
      next = { ...state, nodes: snap.nodes, edges: snap.edges, selectedId: null };
      return addHistory(state, next);
    }

    case 'DELETE_SNAPSHOT':
      return { ...state, snapshots: state.snapshots.filter(s => s.id !== action.payload) };

    default:
      return state;
  }
}

function initState() {
  try {
    const saved = localStorage.getItem('autology_graph');
    if (saved) {
      const data = JSON.parse(saved);
      if (data.nodes?.length > 0 || data.edges?.length > 0) {
        const nodes = data.nodes || [];
        const edges = data.edges || [];
        return { ...initialState, nodes, edges, history: [{ nodes, edges }] };
      }
    }
  } catch {}
  return initialState;
}

export const GraphProvider = ({ children }) => {
  const [state, dispatch] = useReducer(graphReducer, undefined, initState);

  React.useEffect(() => {
    localStorage.setItem('autology_graph', JSON.stringify({
      nodes: state.nodes,
      edges: state.edges.filter(e => !e.inferred),
    }));
  }, [state.nodes, state.edges]);

  return (
    <GraphContext.Provider value={{ state, dispatch }}>
      {children}
    </GraphContext.Provider>
  );
};

export default GraphContext;

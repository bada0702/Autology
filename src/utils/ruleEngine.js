const TYPE_LABEL = 'rdf:type';
const SUBCLASS_LABEL = 'rdfs:subClassOf';
const EQUIVALENT_LABEL = 'owl:equivalentClass';

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function labelMatches(actual, expected) {
  return !expected || norm(actual) === norm(expected);
}

function nodeMatches(node, selector) {
  const wanted = norm(selector);
  if (!wanted) return false;
  return norm(node?.label) === wanted || norm(node?.type) === wanted || norm(node?.id) === wanted;
}

function findNodeBySelector(nodes, selector) {
  const wanted = norm(selector);
  if (!wanted) return null;
  return nodes.find(n => norm(n.id) === wanted || norm(n.label) === wanted) || null;
}

function nodeHasClass(node, classSelector, nodes, edges) {
  if (!node) return false;
  if (nodeMatches(node, classSelector)) return true;
  const cls = findNodeBySelector(nodes, classSelector);
  if (!cls) return false;
  return edges.some(e => e.source === node.id && e.target === cls.id && e.label === TYPE_LABEL);
}

function edgeKey(source, target, label) {
  return `${source}||${target}||${label || ''}`;
}

function makeEdge(id, source, target, label, ruleId, meta = {}) {
  return {
    id,
    source,
    target,
    label,
    style: 'dashed',
    inferred: true,
    ruleId,
    ...meta,
  };
}

// Applies active rules to the current graph and returns new inferred edges.
// Direct (non-inferred) edges are the main input; ontology hierarchy rules may
// read already inferred rdf:type/subClassOf facts generated in this pass.
export function applyRules(nodes, edges, rules) {
  const direct = edges.filter(e => !e.inferred);
  const existingSet = new Set(edges.map(e => edgeKey(e.source, e.target, e.label)));
  const inferSet  = new Set();
  const inferred  = [];
  let n = Date.now();

  const hasEdge = (source, target, label) =>
    existingSet.has(edgeKey(source, target, label)) || inferSet.has(edgeKey(source, target, label));

  const addInferred = (source, target, label, ruleId, meta = {}) => {
    if (!source || !target || source === target) return false;
    const k = edgeKey(source, target, label);
    if (existingSet.has(k) || inferSet.has(k)) return false;
    inferSet.add(k);
    inferred.push(makeEdge(`inf_${n++}`, source, target, label, ruleId, meta));
    return true;
  };

  for (const rule of rules) {
    if (!rule.active) continue;

    if (rule.type === 'transitivity') {
      const label = rule.edgeLabel || null;
      const pool  = label ? direct.filter(e => e.label === label) : direct;

      for (const ab of pool) {
        for (const bc of pool) {
          if (ab.target !== bc.source) continue;
          if (ab.source === bc.target) continue;
          addInferred(ab.source, bc.target, rule.conclusionLabel || label || 'inferred', rule.id);
        }
      }
    }

    if (rule.type === 'inverse') {
      const srcLabel = rule.sourceLabel || null;
      const invLabel = rule.inverseLabel || 'inverse';
      const pool     = srcLabel ? direct.filter(e => e.label === srcLabel) : direct;

      for (const e of pool) {
        addInferred(e.target, e.source, invLabel, rule.id);
      }
    }

    if (rule.type === 'domain') {
      const domainNode = findNodeBySelector(nodes, rule.domainClass || rule.conclusion);
      if (!domainNode) continue;
      for (const e of direct) {
        if (labelMatches(e.label, rule.edgeLabel || rule.sourceLabel)) {
          addInferred(e.source, domainNode.id, TYPE_LABEL, rule.id, { semantic: 'domain' });
        }
      }
    }

    if (rule.type === 'range') {
      const rangeNode = findNodeBySelector(nodes, rule.rangeClass || rule.conclusion);
      if (!rangeNode) continue;
      for (const e of direct) {
        if (labelMatches(e.label, rule.edgeLabel || rule.sourceLabel)) {
          addInferred(e.target, rangeNode.id, TYPE_LABEL, rule.id, { semantic: 'range' });
        }
      }
    }

    if (rule.type === 'subclass') {
      const parentNode = findNodeBySelector(nodes, rule.parentClass || rule.conclusion);
      const childNode = findNodeBySelector(nodes, rule.childClass || rule.condition);
      if (!parentNode || !childNode) continue;
      addInferred(childNode.id, parentNode.id, SUBCLASS_LABEL, rule.id, { semantic: 'subclass' });

      const typeFacts = [...direct, ...inferred].filter(e => e.label === TYPE_LABEL);
      for (const e of typeFacts) {
        if (e.target === childNode.id) {
          addInferred(e.source, parentNode.id, TYPE_LABEL, rule.id, { semantic: 'subclass-type' });
        }
      }
    }

    if (rule.type === 'equivalentClass') {
      const left = findNodeBySelector(nodes, rule.leftClass || rule.condition);
      const right = findNodeBySelector(nodes, rule.rightClass || rule.conclusion);
      if (!left || !right) continue;
      addInferred(left.id, right.id, EQUIVALENT_LABEL, rule.id, { semantic: 'equivalentClass' });
      addInferred(right.id, left.id, EQUIVALENT_LABEL, rule.id, { semantic: 'equivalentClass' });

      const typeFacts = [...direct, ...inferred].filter(e => e.label === TYPE_LABEL);
      for (const e of typeFacts) {
        if (e.target === left.id) addInferred(e.source, right.id, TYPE_LABEL, rule.id, { semantic: 'equivalent-type' });
        if (e.target === right.id) addInferred(e.source, left.id, TYPE_LABEL, rule.id, { semantic: 'equivalent-type' });
      }
    }
  }

  return inferred;
}

export function validateSemanticRules(nodes, edges, rules) {
  const activeRules = rules.filter(r => r.active !== false);
  const violations = [];
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const direct = edges.filter(e => !e.inferred);

  for (const rule of activeRules) {
    if (rule.type === 'domain') {
      for (const e of direct) {
        if (!labelMatches(e.label, rule.edgeLabel || rule.sourceLabel)) continue;
        const src = byId[e.source];
        if (rule.domainClass && !nodeHasClass(src, rule.domainClass, nodes, edges)) {
          violations.push({
            severity: 'error',
            ruleId: rule.id,
            rule: rule.label || 'Domain',
            message: `"${e.label || '(empty)'}" 관계의 source "${src?.label || e.source}"가 domain "${rule.domainClass}"와 맞지 않습니다.`,
            edgeId: e.id,
            nodeId: e.source,
          });
        }
      }
    }

    if (rule.type === 'range') {
      for (const e of direct) {
        if (!labelMatches(e.label, rule.edgeLabel || rule.sourceLabel)) continue;
        const tgt = byId[e.target];
        if (rule.rangeClass && !nodeHasClass(tgt, rule.rangeClass, nodes, edges)) {
          violations.push({
            severity: 'error',
            ruleId: rule.id,
            rule: rule.label || 'Range',
            message: `"${e.label || '(empty)'}" 관계의 target "${tgt?.label || e.target}"가 range "${rule.rangeClass}"와 맞지 않습니다.`,
            edgeId: e.id,
            nodeId: e.target,
          });
        }
      }
    }

    if (rule.type === 'disjointWith') {
      const left = findNodeBySelector(nodes, rule.leftClass || rule.condition);
      const right = findNodeBySelector(nodes, rule.rightClass || rule.conclusion);
      if (!left || !right) continue;
      for (const n of nodes) {
        const typedLeft = edges.some(e => e.source === n.id && e.target === left.id && e.label === TYPE_LABEL);
        const typedRight = edges.some(e => e.source === n.id && e.target === right.id && e.label === TYPE_LABEL);
        if (typedLeft && typedRight) {
          violations.push({
            severity: 'error',
            ruleId: rule.id,
            rule: rule.label || 'Disjoint classes',
            message: `"${n.label}"가 서로소 클래스 "${left.label}"와 "${right.label}"에 동시에 속합니다.`,
            nodeId: n.id,
          });
        }
      }
    }

    if (rule.type === 'cardinality') {
      const min = rule.minCardinality === '' || rule.minCardinality == null ? null : Number(rule.minCardinality);
      const max = rule.maxCardinality === '' || rule.maxCardinality == null ? null : Number(rule.maxCardinality);
      const scopedNodes = rule.domainClass
        ? nodes.filter(n => nodeHasClass(n, rule.domainClass, nodes, edges))
        : nodes;
      for (const node of scopedNodes) {
        const count = direct.filter(e =>
          e.source === node.id && labelMatches(e.label, rule.edgeLabel || rule.sourceLabel)
        ).length;
        if (min != null && count < min) {
          violations.push({
            severity: 'warn',
            ruleId: rule.id,
            rule: rule.label || 'Min cardinality',
            message: `"${node.label}"의 "${rule.edgeLabel}" 관계가 최소 ${min}개 필요하지만 ${count}개입니다.`,
            nodeId: node.id,
          });
        }
        if (max != null && count > max) {
          violations.push({
            severity: 'error',
            ruleId: rule.id,
            rule: rule.label || 'Max cardinality',
            message: `"${node.label}"의 "${rule.edgeLabel}" 관계가 최대 ${max}개여야 하지만 ${count}개입니다.`,
            nodeId: node.id,
          });
        }
      }
    }
  }

  return violations;
}

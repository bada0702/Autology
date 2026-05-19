const BASE_IRI = 'http://autology.local/ontology#';
const BASE_NS  = 'http://autology.local/ontology';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toLocalName(str) {
  return String(str).replace(/\s+/g, '_').replace(/[^\w\-.]/g, '') || null;
}

function escapeTTL(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

function escapeXML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildIRIMap(nodes) {
  const map = {}, used = {};
  nodes.forEach((n, idx) => {
    // Use ASCII label if available, else fall back to positional ID
    const ascii = toLocalName(n.label);
    let base = ascii || `n${idx + 1}`;
    let iri = base, k = 1;
    while (used[iri]) iri = `${base}_${k++}`;
    used[iri] = true;
    map[n.id] = iri;
  });
  return map;
}

// ── TTL Export ────────────────────────────────────────────────────────────────

export function exportToTurtle(nodes, edges) {
  const iriOf = buildIRIMap(nodes);

  const out = [
    `@prefix :    <${BASE_IRI}> .`,
    `@prefix owl: <http://www.w3.org/2002/07/owl#> .`,
    `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .`,
    `@prefix rdfs:<http://www.w3.org/2000/01/rdf-schema#> .`,
    ``,
    `<${BASE_NS}> a owl:Ontology .`,
    ``,
  ];

  // Object property declarations
  const propLabels = [...new Set(
    edges.map(e => e.label).filter(l => l && l !== 'rdf:type')
  )];
  // Build a safe IRI for each edge label (Korean-safe)
  const propIRI = {};
  const usedPropNames = {};
  propLabels.forEach((l, li) => {
    const ascii = toLocalName(l);
    let base = ascii || `rel${li + 1}`;
    let name = base, k = 1;
    while (usedPropNames[name]) name = `${base}_${k++}`;
    usedPropNames[name] = true;
    propIRI[l] = name;
  });

  if (propLabels.length) {
    out.push(`# Object Properties`);
    for (const l of propLabels) {
      out.push(`:${propIRI[l]} a owl:ObjectProperty ; rdfs:label "${escapeTTL(l)}" .`);
    }
    out.push('');
  }

  function renderNode(n, owlType) {
    const iri = iriOf[n.id];
    const lines = [`a ${owlType}`, `rdfs:label "${escapeTTL(n.label)}"`];
    if (n.description) lines.push(`rdfs:comment "${escapeTTL(n.description)}"`);
    (n.properties || []).forEach((p, pi) => {
      if (p.key && p.value) {
        const predName = toLocalName(p.key) || `prop${pi + 1}`;
        lines.push(`:${predName} "${escapeTTL(p.value)}"`);
      }
    });
    out.push(`:${iri}`);
    lines.forEach((l, i) => out.push(`    ${i < lines.length - 1 ? l + ' ;' : l + ' .'}`));
    out.push('');
  }

  const classes   = nodes.filter(n => n.type === 'Class');
  const instances = nodes.filter(n => n.type === 'Instance');
  const literals  = nodes.filter(n => n.type === 'Literal');

  if (classes.length)   { out.push('# Classes');      classes.forEach(n => renderNode(n, 'owl:Class')); }
  if (instances.length) { out.push('# Individuals'); instances.forEach(n => renderNode(n, 'owl:NamedIndividual')); }
  if (literals.length)  { out.push('# Literals');     literals.forEach(n => renderNode(n, 'rdfs:Literal')); }

  const assertions = edges.filter(e => iriOf[e.source] && iriOf[e.target]);
  if (assertions.length) {
    out.push('# Assertions');
    for (const e of assertions) {
      const pred = e.label === 'rdf:type' ? 'rdf:type' : `:${propIRI[e.label] || toLocalName(e.label) || 'relatedTo'}`;
      out.push(`:${iriOf[e.source]} ${pred} :${iriOf[e.target]} .${e.inferred ? ' # inferred' : ''}`);
    }
  }

  return out.join('\n');
}

// ── OWL/RDF-XML Export ────────────────────────────────────────────────────────

export function exportToOWL(nodes, edges) {
  const iriOf = buildIRIMap(nodes);

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rdf:RDF`,
    `  xmlns="${BASE_IRI}"`,
    `  xmlns:owl="http://www.w3.org/2002/07/owl#"`,
    `  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"`,
    `  xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"`,
    `  xmlns:xsd="http://www.w3.org/2001/XMLSchema#"`,
    `  xml:base="${BASE_NS}">`,
    ``,
    `  <owl:Ontology rdf:about="${BASE_NS}"/>`,
  ];

  const propLabels = [...new Set(
    edges.map(e => e.label).filter(l => l && l !== 'rdf:type')
  )];
  const owlPropIRI = {};
  const usedOwlPropNames = {};
  propLabels.forEach((l, li) => {
    const ascii = toLocalName(l);
    let base = ascii || `rel${li + 1}`;
    let name = base, k = 1;
    while (usedOwlPropNames[name]) name = `${base}_${k++}`;
    usedOwlPropNames[name] = true;
    owlPropIRI[l] = name;
  });
  for (const l of propLabels) {
    xml.push(``, `  <owl:ObjectProperty rdf:about="${BASE_IRI}${owlPropIRI[l]}">`);
    xml.push(`    <rdfs:label xml:lang="ko">${escapeXML(l)}</rdfs:label>`);
    xml.push(`  </owl:ObjectProperty>`);
  }

  function renderXMLNode(n, tag) {
    const iri = iriOf[n.id];
    xml.push(``, `  <${tag} rdf:about="${BASE_IRI}${iri}">`);
    xml.push(`    <rdfs:label xml:lang="ko">${escapeXML(n.label)}</rdfs:label>`);
    if (n.description) xml.push(`    <rdfs:comment xml:lang="ko">${escapeXML(n.description)}</rdfs:comment>`);
    for (const p of (n.properties || [])) {
      if (p.key && p.value) {
        const t = toLocalName(p.key);
        xml.push(`    <${t} rdf:datatype="http://www.w3.org/2001/XMLSchema#string">${escapeXML(p.value)}</${t}>`);
      }
    }
    xml.push(`  </${tag}>`);
  }

  nodes.filter(n => n.type === 'Class').forEach(n => renderXMLNode(n, 'owl:Class'));
  nodes.filter(n => n.type === 'Instance').forEach(n => renderXMLNode(n, 'owl:NamedIndividual'));
  nodes.filter(n => n.type === 'Literal').forEach(n => {
    const iri = iriOf[n.id];
    xml.push(``, `  <rdfs:Datatype rdf:about="${BASE_IRI}${iri}">`);
    xml.push(`    <rdfs:label xml:lang="ko">${escapeXML(n.label)}</rdfs:label>`);
    if (n.description) xml.push(`    <rdfs:comment xml:lang="ko">${escapeXML(n.description)}</rdfs:comment>`);
    xml.push(`  </rdfs:Datatype>`);
  });

  for (const e of edges) {
    const src = iriOf[e.source], tgt = iriOf[e.target];
    if (!src || !tgt) continue;
    xml.push(``, `  <rdf:Description rdf:about="${BASE_IRI}${src}">`);
    if (e.label === 'rdf:type') {
      xml.push(`    <rdf:type rdf:resource="${BASE_IRI}${tgt}"/>`);
    } else {
      const p = owlPropIRI[e.label] || toLocalName(e.label) || 'relatedTo';
      xml.push(`    <${p} rdf:resource="${BASE_IRI}${tgt}"/>${e.inferred ? '<!-- inferred -->' : ''}`);
    }
    xml.push(`  </rdf:Description>`);
  }

  xml.push(``, `</rdf:RDF>`);
  return xml.join('\n');
}

// ── Layout helper ─────────────────────────────────────────────────────────────

function layoutAndFinalize(nodeMap, edgeList) {
  const SKIP = new Set([
    'owl:ObjectProperty', 'owl:DatatypeProperty', 'owl:AnnotationProperty',
    'owl:Ontology', 'owl:TransitiveProperty', 'owl:SymmetricProperty',
    'owl:FunctionalProperty', 'owl:InverseFunctionalProperty',
  ]);

  const validNodes = Object.entries(nodeMap)
    .filter(([, n]) => n.label && !SKIP.has(n._rdfType) && !SKIP.has(n.iri));

  const classes   = validNodes.filter(([, n]) => n.type === 'Class');
  const instances = validNodes.filter(([, n]) => n.type === 'Instance');
  const literals  = validNodes.filter(([, n]) => n.type === 'Literal');

  let idC = Date.now();
  const iriToId = {};

  const finalNodes = [];

  for (const [i, [iri, n]] of classes.entries()) {
    const id = `node_${idC++}`;
    iriToId[iri] = id;
    finalNodes.push({ id, label: n.label, type: 'Class',
      x: (i % 5) * 220 + 80, y: 80,
      description: n.description || '', properties: n.properties || [] });
  }
  for (const [i, [iri, n]] of instances.entries()) {
    const id = `node_${idC++}`;
    iriToId[iri] = id;
    finalNodes.push({ id, label: n.label, type: 'Instance',
      x: (i % 5) * 200 + 80, y: 300 + Math.floor(i / 5) * 160,
      description: n.description || '', properties: n.properties || [] });
  }
  for (const [i, [iri, n]] of literals.entries()) {
    const id = `node_${idC++}`;
    iriToId[iri] = id;
    finalNodes.push({ id, label: n.label, type: 'Literal',
      x: (i % 5) * 180 + 80, y: 520 + Math.floor(i / 5) * 130,
      description: n.description || '', properties: n.properties || [] });
  }

  const seen = new Set();
  const finalEdges = [];
  for (const e of edgeList) {
    const src = iriToId[e.srcIRI], tgt = iriToId[e.tgtIRI];
    if (!src || !tgt || src === tgt) continue;
    const key = `${src}|${tgt}|${e.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    finalEdges.push({
      id: `edge_${idC++}`, source: src, target: tgt,
      label: e.label, style: e.inferred ? 'dashed' : 'solid', inferred: !!e.inferred,
    });
  }

  return { nodes: finalNodes, edges: finalEdges };
}

// ── Turtle Parser ─────────────────────────────────────────────────────────────

export function parseTurtle(text) {
  // Strip comments
  text = text.replace(/#[^\n]*/g, '');

  // Collect prefix declarations
  const prefixes = {};
  text = text.replace(/@prefix\s+(\w*):\s+<([^>]+)>\s*\./g, (_, p, uri) => {
    prefixes[p] = uri;
    return '';
  });
  const baseIRI = prefixes[''] || BASE_IRI;

  const tokens = tokenize(text);
  const triples = triplify(tokens);

  const nodeMap = {};  // resolvedIRI → node data
  const edgeList = [];
  const skipIRIs = new Set();

  function ensureNode(iri) {
    if (!nodeMap[iri]) {
      nodeMap[iri] = { iri, label: localFrag(iri), type: 'Instance', description: '', properties: [] };
    }
    return nodeMap[iri];
  }

  const SKIP_TYPES = new Set([
    'owl:ObjectProperty', 'owl:DatatypeProperty', 'owl:AnnotationProperty', 'owl:Ontology',
  ]);

  for (const { s, p, o } of triples) {
    const sIRI = resolve(s, prefixes, baseIRI);
    const pIRI = resolve(p, prefixes, baseIRI);
    const oIRI = resolve(o, prefixes, baseIRI);
    if (!sIRI || !pIRI) continue;

    if (pIRI === 'rdf:type' || p === 'a') {
      if (SKIP_TYPES.has(oIRI)) { skipIRIs.add(sIRI); continue; }
      const nd = ensureNode(sIRI);
      if (oIRI === 'owl:Class')    nd.type = 'Class';
      else if (oIRI === 'rdfs:Datatype' || oIRI === 'rdfs:Literal') nd.type = 'Literal';
      else if (oIRI === 'owl:NamedIndividual') nd.type = 'Instance';
      else if (!oIRI.startsWith('owl:') && !oIRI.startsWith('rdf:') && !oIRI.startsWith('rdfs:')) {
        edgeList.push({ srcIRI: sIRI, tgtIRI: oIRI, label: 'rdf:type' });
      }
    } else if (pIRI === 'rdfs:label') {
      ensureNode(sIRI).label = isLit(o) ? unquote(o) : oIRI;
    } else if (pIRI === 'rdfs:comment') {
      ensureNode(sIRI).description = isLit(o) ? unquote(o) : oIRI;
    } else if (!pIRI.startsWith('owl:') && !pIRI.startsWith('rdfs:') && !pIRI.startsWith('rdf:')) {
      const predLabel = localFrag(pIRI);
      if (isLit(o)) {
        ensureNode(sIRI).properties.push({ key: predLabel, value: unquote(o) });
      } else {
        edgeList.push({ srcIRI: sIRI, tgtIRI: oIRI, label: predLabel });
      }
    }
  }

  for (const iri of skipIRIs) delete nodeMap[iri];

  return layoutAndFinalize(nodeMap, edgeList);
}

function tokenize(text) {
  const tokens = [];
  let i = 0, len = text.length;
  while (i < len) {
    if (/\s/.test(text[i])) { i++; continue; }

    if (text[i] === '<') {
      const e = text.indexOf('>', i);
      if (e < 0) { i++; continue; }
      tokens.push(text.slice(i, e + 1));
      i = e + 1;
      continue;
    }

    if (text[i] === '"') {
      let j = i + 1;
      while (j < len) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') { j++; break; }
        j++;
      }
      if (j < len && text[j] === '^' && text[j + 1] === '^') {
        j += 2;
        if (text[j] === '<') { const e = text.indexOf('>', j); j = e >= 0 ? e + 1 : j; }
        else { while (j < len && !/[\s,;.)]/.test(text[j])) j++; }
      } else if (j < len && text[j] === '@') {
        j++;
        while (j < len && /[\w-]/.test(text[j])) j++;
      }
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }

    if ((text[i] === ';') || (text[i] === ',')) { tokens.push(text[i++]); continue; }

    if (text[i] === '.') {
      const next = i + 1;
      if (next >= len || /\s/.test(text[next])) { tokens.push('.'); i++; continue; }
    }

    // Prefixed name, keyword, or bare name
    let j = i;
    while (j < len && !/[\s,;]/.test(text[j])) {
      if (text[j] === '.' && (j + 1 >= len || /\s/.test(text[j + 1]))) break;
      j++;
    }
    if (j > i) { tokens.push(text.slice(i, j)); i = j; }
    else i++;
  }
  return tokens;
}

function triplify(tokens) {
  const triples = [];
  let i = 0;
  while (i < tokens.length) {
    const s = tokens[i++];
    if (!s || s === '.') continue;

    // Read predicate-object pairs for this subject
    outer:
    while (i < tokens.length && tokens[i] !== '.') {
      const p = tokens[i++];
      if (!p || p === ';') { if (p === ';') continue; break; }
      if (p === '.') break;

      // Read object(s)
      while (i < tokens.length) {
        const o = tokens[i];
        if (!o || o === '.' || o === ';') break;
        i++;
        triples.push({ s, p, o });
        if (i < tokens.length && tokens[i] === ',') { i++; continue; }
        break;
      }
      if (i < tokens.length && tokens[i] === ';') { i++; continue; }
      break;
    }
    if (i < tokens.length && tokens[i] === '.') i++;
  }
  return triples;
}

function resolve(token, prefixes, baseIRI) {
  if (!token) return '';
  if (token === 'a') return 'rdf:type';
  if (token.startsWith('<') && token.endsWith('>')) {
    const full = token.slice(1, -1);
    // Check if it matches a known prefix base and get local name
    for (const [p, uri] of Object.entries(prefixes)) {
      if (full.startsWith(uri)) return `${p}:${full.slice(uri.length)}`;
    }
    return localFrag(full);
  }
  if (token.startsWith('"')) return token; // literal — returned as-is for isLit check
  if (token.includes(':')) {
    const [prefix, local] = token.split(':', 2);
    if (['owl', 'rdf', 'rdfs', 'xsd'].includes(prefix)) return `${prefix}:${local}`;
    if (prefix === '' && prefixes['']) return local;
    if (prefixes[prefix]) return local;
    return `${prefix}:${local}`;
  }
  return token;
}

function localFrag(iri) {
  if (!iri) return '';
  const h = iri.lastIndexOf('#'), s = iri.lastIndexOf('/');
  const i = Math.max(h, s);
  return i >= 0 ? iri.slice(i + 1) : iri;
}

function isLit(token) { return token && token.startsWith('"'); }

function unquote(token) {
  // "value"^^type  or  "value"@lang  or  "value"
  return token
    .replace(/^"([\s\S]*?)"(?:\^\^[^\s,;.]+|@[\w-]+)?$/, '$1')
    .replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// ── OWL/RDF-XML Parser ────────────────────────────────────────────────────────

export function parseOWL(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('OWL/XML 파싱 오류: ' + err.textContent.slice(0, 120));

  const OWL  = 'http://www.w3.org/2002/07/owl#';
  const RDF  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

  const nodeMap = {};
  const edgeList = [];

  function getAbout(el) {
    return el.getAttributeNS(RDF, 'about') || el.getAttribute('rdf:about') || '';
  }
  function lf(iri) { return localFrag(iri) || iri; }
  function ensureNode(iri, type) {
    if (!nodeMap[iri]) nodeMap[iri] = { iri, label: lf(iri), type, description: '', properties: [] };
    return nodeMap[iri];
  }

  // owl:Class
  for (const el of doc.getElementsByTagNameNS(OWL, 'Class')) {
    const iri = getAbout(el); if (!iri || iri.startsWith('http://www.w3.org')) continue;
    const nd = ensureNode(iri, 'Class');
    const lbl = el.querySelector('label'); if (lbl) nd.label = lbl.textContent.trim();
    const cmt = el.querySelector('comment'); if (cmt) nd.description = cmt.textContent.trim();
    for (const ch of el.children) {
      if (['label','comment'].includes(ch.localName)) continue;
      const res = ch.getAttribute('rdf:resource');
      if (!res && ch.textContent.trim()) nd.properties.push({ key: ch.localName, value: ch.textContent.trim() });
    }
  }

  // owl:NamedIndividual
  for (const el of doc.getElementsByTagNameNS(OWL, 'NamedIndividual')) {
    const iri = getAbout(el); if (!iri) continue;
    const nd = ensureNode(iri, 'Instance');
    const lbl = el.querySelector('label'); if (lbl) nd.label = lbl.textContent.trim();
    const cmt = el.querySelector('comment'); if (cmt) nd.description = cmt.textContent.trim();
    for (const ch of el.children) {
      if (['label','comment'].includes(ch.localName)) continue;
      const res = ch.getAttribute('rdf:resource');
      if (ch.localName === 'type') {
        if (res && !res.startsWith(OWL)) edgeList.push({ srcIRI: iri, tgtIRI: lf(res), label: 'rdf:type' });
      } else if (res) {
        edgeList.push({ srcIRI: iri, tgtIRI: lf(res), label: ch.localName });
      } else if (ch.textContent.trim()) {
        nd.properties.push({ key: ch.localName, value: ch.textContent.trim() });
      }
    }
  }

  // rdfs:Datatype
  for (const el of doc.getElementsByTagNameNS(RDFS, 'Datatype')) {
    const iri = getAbout(el); if (!iri || iri.startsWith('http://www.w3.org')) continue;
    const nd = ensureNode(iri, 'Literal');
    const lbl = el.querySelector('label'); if (lbl) nd.label = lbl.textContent.trim();
  }

  // rdf:Description (for assertions declared separately)
  for (const el of doc.getElementsByTagNameNS(RDF, 'Description')) {
    const iri = getAbout(el); if (!iri || !nodeMap[iri]) continue;
    for (const ch of el.children) {
      if (['label','comment','type'].includes(ch.localName)) continue;
      const res = ch.getAttribute('rdf:resource');
      if (res) edgeList.push({ srcIRI: iri, tgtIRI: lf(res), label: ch.localName });
    }
  }

  return layoutAndFinalize(nodeMap, edgeList);
}

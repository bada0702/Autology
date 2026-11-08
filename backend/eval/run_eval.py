"""
Quality evaluation for the ontology pipeline.

Suites (gold data in eval/data/):
  normalization  edge phrase → core relation (offline, deterministic)
  retrieval      relation phrase → Wikidata property, candidate recall@k (offline + bge-m3)
  relations      relation linking end to end with the LLM (precision / recall / abstention)
  entities       node → Wikidata item with the LLM and Wikidata search
  reasoning      our OWL 2 RL closure vs owlrl on random graphs (soundness / completeness)
  paths          path search vs brute-force enumeration on random graphs

Usage:
  cd backend
  ./venv/Scripts/python eval/run_eval.py                      # all suites
  ./venv/Scripts/python eval/run_eval.py --suites normalization,reasoning,paths
  ./venv/Scripts/python eval/run_eval.py --suites relations,entities --repeat 3 --model qwen3.5:4b
  ./venv/Scripts/python eval/run_eval.py --verify-gold        # check gold Q-ids against Wikidata

Results are printed and written to eval/results/<timestamp>.json.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import random
import statistics
import sys
import time
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
DATA = os.path.join(HERE, "data")
OFFLINE = ("normalization", "retrieval", "reasoning", "paths")
LLM = ("relations", "entities")


def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)


def pct(a, b):
    return round(100.0 * a / b, 1) if b else None


def show(title, metrics, failures=()):
    print(f"\n── {title} " + "─" * max(0, 60 - len(title)))
    for k, v in metrics.items():
        print(f"  {k:<28} {v}")
    for f in list(failures)[:25]:
        print(f"    ✗ {f}")
    if len(failures) > 25:
        print(f"    … {len(failures) - 25} more")


# ── normalization ────────────────────────────────────────────────────────

TYPES = {"I": "Instance", "C": "Class"}


def eval_normalization():
    import vocabulary as vocab
    items = load("normalization.json")["items"]
    ok, fails, by_kind = 0, [], Counter()
    for it in items:
        st, tt = (TYPES[c] for c in it["types"])
        r = vocab.resolve(it["phrase"], st, tt)
        got = [r.relation, bool(r.flipped)]
        if got in it["expect"]:
            ok += 1
        else:
            kind = "missed (stayed custom)" if r.relation == vocab.CUSTOM else (
                "false core match" if it["expect"] == [["custom", False]] else "wrong relation/direction")
            by_kind[kind] += 1
            fails.append(f"{it['phrase']!r}: got {got}, expected {it['expect']}")
    m = {"items": len(items), "accuracy %": pct(ok, len(items)), **{f"  {k}": v for k, v in by_kind.items()}}
    show("normalization (phrase → core relation)", m, fails)
    return {"metrics": m, "failures": fails}


# ── relation retrieval ───────────────────────────────────────────────────

def _relation_items():
    for g in load("relations.json")["groups"]:
        for s, phrase, t, accept in g["items"]:
            yield g["topic"], s, phrase, t, accept


def eval_retrieval(k=5):
    import vocab_rag
    import vocabulary as vocab
    vocab_rag._embeddings.ensure()   # build or load the bge-m3 index before measuring
    out = {}
    for use_emb in (False, True):
        hits = total = 0
        fails = []
        for _, s, phrase, t, accept in _relation_items():
            pids = [a for a in accept if a.startswith("P")]
            if not pids or vocab.resolve(phrase).relation != vocab.CUSTOM:
                continue
            total += 1
            cands = vocab_rag.with_inverses(vocab_rag.search(phrase, k, use_embeddings=use_emb))
            ids = [c["id"] for c in cands]
            if set(ids) & set(pids):
                hits += 1
            else:
                fails.append(f"{phrase!r} want {pids}, got {ids[:k]}")
        name = "hybrid (lexical+bge-m3)" if use_emb else "lexical only"
        out[name] = {"recall@%d %%" % k: pct(hits, total), "items": total, "failures": fails}
    st = vocab_rag.status()
    m = {f"{n} recall@{k} %": v[f"recall@{k} %"] for n, v in out.items()}
    m["items"] = out["lexical only"]["items"]
    m["embedding index ready"] = st["embeddings_ready"]
    show(f"relation retrieval (candidate recall@{k}, incl. inverses)", m,
         out["hybrid (lexical+bge-m3)"]["failures"])
    return {"metrics": m, "details": out}


# ── relation linking (LLM) ───────────────────────────────────────────────

def _relation_graph(group):
    nodes, ids, edges, gold = [], {}, [], {}

    def node(label):
        if label not in ids:
            ids[label] = f"n{len(ids)}"
            nodes.append({"id": ids[label], "label": label, "type": "Instance"})
        return ids[label]

    for i, (s, phrase, t, accept) in enumerate(group["items"]):
        eid = f"e{i}"
        edges.append({"id": eid, "source": node(s), "target": node(t), "label": phrase})
        gold[eid] = (s, phrase, t, accept, ids[s])
    return {"nodes": nodes, "edges": edges}, gold


async def _relations_once(chat):
    import vocab_rag
    import vocabulary as vocab
    vocab_rag._embeddings.ensure()   # the server warms this up at startup
    rows = []
    for group in load("relations.json")["groups"]:
        graph, gold = _relation_graph(group)
        vocab.normalize_graph(graph)
        await vocab_rag.link_relations(graph, chat)
        vocab.normalize_graph(graph)
        by_id = {e["id"]: e for e in graph["edges"]}
        for eid, (s, phrase, t, accept, src_id) in gold.items():
            e = by_id.get(eid)
            wd = (e or {}).get("wikidata") or {}
            tags = set()
            if wd.get("id"):
                tags.add(wd["id"])
            rel = (e or {}).get("relation", vocab.CUSTOM)
            if e and rel not in (vocab.CUSTOM,):
                tags.add(f"core:{rel}" + ("" if e["source"] == src_id else "^-1"))
            linked = bool(wd.get("id"))
            if accept:
                verdict = "correct" if tags & set(accept) else ("wrong" if linked else "missed")
            else:
                verdict = "false link" if linked else "abstained"
            rows.append({"triple": f"{s} [{phrase}] {t}", "accept": accept, "got": sorted(tags),
                         "method": wd.get("method"), "verdict": verdict})
    return rows


def _relation_metrics(rows):
    c = Counter(r["verdict"] for r in rows)
    pos = sum(1 for r in rows if r["accept"])
    neg = len(rows) - pos
    links = c["correct"] + c["wrong"] + c["false link"]
    return {
        "precision %": pct(c["correct"], links),
        "recall %": pct(c["correct"], pos),
        "abstention %": pct(c["abstained"], neg),
        "correct": c["correct"], "wrong": c["wrong"], "missed": c["missed"],
        "false link": c["false link"], "positives": pos, "negatives": neg,
        "by method": dict(Counter(r["method"] or "-" for r in rows if r["verdict"] in ("correct", "wrong", "false link"))),
    }


# ── entity linking (LLM + Wikidata) ──────────────────────────────────────

async def _entities_once(chat):
    import entity_link as el
    import httpx
    rows = []
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": el.USER_AGENT}) as client:
        raw: dict[str, dict] = defaultdict(dict)

        async def search(label, lang):
            items = await el.search_entities(label, lang, client)
            for it in items:
                raw[label].setdefault(it["id"], it)
            return items

        for g in load("entities.json")["graphs"]:
            ids = {lab: f"n{i}" for i, (lab, _, _) in enumerate(g["nodes"])}
            graph = {"nodes": [{"id": ids[lab], "label": lab, "type": typ} for lab, typ, _ in g["nodes"]],
                     "edges": [{"id": f"e{i}", "source": ids[s], "target": ids[t], "label": p}
                               for i, (s, p, t) in enumerate(g["edges"])]}
            await el.link_entities(graph, chat, g["topic"], search=search)
            by_label = {n["label"]: n for n in graph["nodes"]}
            for lab, _, expect in g["nodes"]:
                got = by_label[lab].get("wikidata_id")
                cands = [c["id"] for c in el.filter_candidates(lab, list(raw[lab].values()))[:el.CANDIDATES]]
                if expect:
                    verdict = "correct" if got in expect else ("wrong" if got else "missed")
                else:
                    verdict = "false link" if got else "abstained"
                rows.append({"topic": g["topic"], "label": lab, "expect": expect, "got": got,
                             "gold_in_candidates": bool(set(expect) & set(cands)) if expect else None,
                             "candidates": cands, "verdict": verdict})
    return rows


def _entity_metrics(rows):
    m = _relation_metrics([{**r, "accept": r["expect"], "method": None} for r in rows])
    m.pop("by method")
    pos = [r for r in rows if r["expect"]]
    m["gold in candidates %"] = pct(sum(r["gold_in_candidates"] for r in pos), len(pos))
    m["selection acc. when gold present %"] = pct(
        sum(r["verdict"] == "correct" for r in pos if r["gold_in_candidates"]),
        sum(1 for r in pos if r["gold_in_candidates"]))
    return m


def _fail_lines_rel(rows):
    return [f"[{r['verdict']}] {r['triple']} → {r['got'] or '-'} (accept {r['accept'] or 'none'}; {r['method']})"
            for r in rows if r["verdict"] not in ("correct", "abstained")]


def _fail_lines_ent(rows):
    return [f"[{r['verdict']}] {r['topic']}/{r['label']} → {r['got'] or '-'} (expect {r['expect'] or 'none'}; "
            f"gold in cands: {r['gold_in_candidates']}; cands {r['candidates']})"
            for r in rows if r["verdict"] not in ("correct", "abstained")]


def _aggregate(runs, metric_fn, keys):
    per = [metric_fn(r) for r in runs]
    agg = {}
    for k in keys:
        vals = [p[k] for p in per if p.get(k) is not None]
        if vals:
            agg[k] = (f"{statistics.mean(vals):.1f}" + (f"  (min {min(vals)}, max {max(vals)})" if len(vals) > 1 else ""))
    return per, agg


async def eval_llm(suite, repeat):
    from crew.ollama_pipeline import quick_chat
    once, metric_fn, fail_fn, keys = {
        "relations": (_relations_once, _relation_metrics, _fail_lines_rel,
                      ["precision %", "recall %", "abstention %"]),
        "entities": (_entities_once, _entity_metrics, _fail_lines_ent,
                     ["precision %", "recall %", "abstention %", "gold in candidates %",
                      "selection acc. when gold present %"]),
    }[suite]
    runs, secs = [], []
    for i in range(repeat):
        t0 = time.time()
        runs.append(await once(quick_chat))
        secs.append(round(time.time() - t0, 1))
    per, agg = _aggregate(runs, metric_fn, keys)
    agg["runs"] = repeat
    agg["seconds per run"] = secs
    last = per[-1]
    agg.update({k: last[k] for k in ("correct", "wrong", "missed", "false link", "positives", "negatives")})
    if "by method" in last:
        agg["links by method (last run)"] = last["by method"]
    # Failures that recur in every run are the systematic ones.
    fails = Counter(line for r in runs for line in set(fail_fn(r)))
    lines = [f"{n}/{repeat}  {line}" for line, n in fails.most_common()]
    title = "relation linking (LLM, end to end)" if suite == "relations" else "entity linking (LLM + Wikidata)"
    show(title, agg, lines)
    return {"metrics": agg, "per_run": per, "runs": runs}


# ── reasoning vs owlrl ───────────────────────────────────────────────────

INSTANCE_RELS = ["part-of", "located-in", "member-of", "precedes", "depends-on", "causes",
                 "uses", "produces", "participates-in", "has-property", "related-to"]


def _random_graph(rng, n_cls=6, n_inst=10, n_sub=5, n_type=6, n_rel=14):
    nodes = [{"id": f"c{i}", "label": f"클래스{i}", "type": "Class"} for i in range(n_cls)]
    nodes += [{"id": f"i{i}", "label": f"개체{i}", "type": "Instance"} for i in range(n_inst)]
    edges, seen = [], set()

    def add(s, label, t):
        if s != t and (s, label, t) not in seen:
            seen.add((s, label, t))
            edges.append({"id": f"e{len(edges)}", "source": s, "target": t, "label": label})

    for _ in range(n_sub):
        add(f"c{rng.randrange(n_cls)}", "rdfs:subClassOf", f"c{rng.randrange(n_cls)}")
    for _ in range(n_type):
        add(f"i{rng.randrange(n_inst)}", "rdf:type", f"c{rng.randrange(n_cls)}")
    for _ in range(n_rel):
        add(f"i{rng.randrange(n_inst)}", rng.choice(INSTANCE_RELS), f"i{rng.randrange(n_inst)}")
    return {"nodes": nodes, "edges": edges}


def eval_reasoning(n_graphs=40, seed=7):
    import owlrl
    from rdflib import RDF, RDFS, URIRef
    import vocabulary as vocab
    from reasoning import analyze
    from semantic import BASE_IRI, graph_to_rdf

    names = {RDF.type: "rdf:type", RDFS.subClassOf: "rdfs:subClassOf"}
    for r in INSTANCE_RELS:
        names[URIRef(BASE_IRI + r)] = r

    rng = random.Random(seed)
    tp = only_ours = only_owl = 0
    by_rel_missing, by_rel_extra = Counter(), Counter()
    examples = []
    t_ours = t_owl = 0.0
    for gi in range(n_graphs):
        g = _random_graph(rng)
        t0 = time.time()
        result = analyze(g)
        t_ours += time.time() - t0
        direct = {(e["source"], e["label"], e["target"])
                  for e in vocab.normalize_graph(copy.deepcopy(g))["edges"]}
        ours = direct | {(e["source"], e["label"], e["target"]) for e in result["inferred"]}
        ours = {x for x in ours if x[1] in names.values() and x[0] != x[2]}

        rdf = graph_to_rdf(g)
        t0 = time.time()
        owlrl.DeductiveClosure(owlrl.OWLRL_Semantics).expand(rdf)
        t_owl += time.time() - t0
        label_to_id = {n["label"]: n["id"] for n in g["nodes"]}
        uri_to_id = {s: label_to_id[str(o)] for s, o in rdf.subject_objects(RDFS.label)
                     if str(o) in label_to_id and str(s).startswith(BASE_IRI)}
        owl = {(uri_to_id[s], names[p], uri_to_id[o]) for s, p, o in rdf
               if p in names and s in uri_to_id and o in uri_to_id and s != o}

        tp += len(ours & owl)
        for x in owl - ours:
            only_owl += 1
            by_rel_missing[x[1]] += 1
            if len(examples) < 8:
                examples.append(f"graph {gi}: missing {x}")
        for x in ours - owl:
            only_ours += 1
            by_rel_extra[x[1]] += 1
            if len(examples) < 8:
                examples.append(f"graph {gi}: extra (unsound?) {x}")
    m = {
        "random graphs": n_graphs,
        "soundness % (ours ⊆ owlrl)": pct(tp, tp + only_ours),
        "completeness % (owlrl ⊆ ours)": pct(tp, tp + only_owl),
        "missing by relation": dict(by_rel_missing),
        "extra by relation": dict(by_rel_extra),
        "time ours / owlrl (s)": f"{t_ours:.2f} / {t_owl:.2f}",
    }
    show("reasoning vs owlrl (OWL 2 RL closure)", m, examples)
    return {"metrics": m, "examples": examples}


# ── path search vs brute force ───────────────────────────────────────────

def _brute_paths(adj, src, dst, max_hops):
    out = []

    def dfs(path):
        cur = path[-1]
        if cur == dst:
            out.append(list(path))
            return
        if len(path) - 1 >= max_hops:
            return
        for nb in adj.get(cur, ()):
            if nb not in path:
                path.append(nb)
                dfs(path)
                path.pop()
    dfs([src])
    return out


def eval_paths(n_cases=150, seed=11):
    from explore import Explorer
    rng = random.Random(seed)
    stats = Counter()
    fails = []
    t_total = 0.0
    for case in range(n_cases):
        n = rng.randint(8, 25)
        nodes = [{"id": f"x{i}", "label": f"노드{i}", "type": "Instance"} for i in range(n)]
        edges, seen = [], set()
        for _ in range(rng.randint(n, 3 * n)):
            a, b = rng.randrange(n), rng.randrange(n)
            if a != b and (a, b) not in seen:
                seen.add((a, b))
                edges.append({"id": f"e{len(edges)}", "source": f"x{a}", "target": f"x{b}",
                              "label": rng.choice(["uses", "produces", "depends-on"])})
        g = {"nodes": nodes, "edges": edges}
        directed = rng.random() < 0.5
        max_hops, max_paths = rng.randint(2, 5), rng.randint(1, 8)
        src, dst = f"x{rng.randrange(n)}", f"x{rng.randrange(n)}"
        if src == dst:
            continue
        adj = defaultdict(set)
        for e in edges:
            adj[e["source"]].add(e["target"])
            if not directed:
                adj[e["target"]].add(e["source"])
        truth = _brute_paths(adj, src, dst, max_hops)
        ex = Explorer(g, include_inferred=False)
        t0 = time.time()
        got = ex.paths([src], [dst], max_hops, max_paths, None, directed)["paths"]
        t_total += time.time() - t0
        stats["cases"] += 1
        truth_set = {tuple(p) for p in truth}
        got_seqs = [tuple(p["nodes"]) for p in got]
        if truth:
            stats["reachable"] += 1
        if any(s not in truth_set for s in got_seqs):
            stats["invalid path returned"] += 1
            fails.append(f"case {case}: invalid {[s for s in got_seqs if s not in truth_set][:1]}")
            continue
        expected_hops = sorted(len(p) - 1 for p in truth)[:max_paths]
        got_hops = sorted(len(s) - 1 for s in got_seqs)
        if got_hops == expected_hops:
            stats["optimal (k shortest)"] += 1
        else:
            fails.append(f"case {case}: hops {got_hops} vs shortest {expected_hops} (directed={directed})")
        if truth and not got:
            stats["missed reachable"] += 1
    m = {
        "cases": stats["cases"], "reachable pairs": stats["reachable"],
        "valid paths %": pct(stats["cases"] - stats["invalid path returned"], stats["cases"]),
        "k-shortest optimal %": pct(stats["optimal (k shortest)"], stats["cases"]),
        "missed reachable": stats["missed reachable"],
        "avg ms per query": round(1000 * t_total / max(1, stats["cases"]), 2),
    }
    show("path search vs brute force", m, fails)
    return {"metrics": m, "failures": fails}


# ── gold verification ────────────────────────────────────────────────────

async def verify_gold():
    import entity_link as el
    import httpx
    qids = sorted({q for g in load("entities.json")["graphs"] for _, _, exp in g["nodes"] for q in exp},
                  key=lambda q: int(q[1:]))
    async with httpx.AsyncClient(timeout=20, headers={"User-Agent": el.USER_AGENT}) as client:
        r = await client.get(el.API, params={"action": "wbgetentities", "ids": "|".join(qids),
                                             "props": "labels|descriptions", "languages": "ko|en",
                                             "format": "json"})
        ents = r.json()["entities"]
    for q in qids:
        e = ents.get(q, {})
        lab = e.get("labels", {})
        print(f"  {q:<10} ko={lab.get('ko', {}).get('value')!r:<20} en={lab.get('en', {}).get('value')!r} — "
              f"{e.get('descriptions', {}).get('en', {}).get('value')}")


# ── main ─────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--suites", default=",".join(OFFLINE + LLM))
    ap.add_argument("--repeat", type=int, default=1, help="runs per LLM suite")
    ap.add_argument("--model", help="Ollama model for LLM suites (sets OLLAMA_MODEL)")
    ap.add_argument("--verify-gold", action="store_true")
    args = ap.parse_args()
    if args.model:
        os.environ["OLLAMA_MODEL"] = args.model
    if args.verify_gold:
        asyncio.run(verify_gold())
        return

    suites = [s.strip() for s in args.suites.split(",") if s.strip()]
    report = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "suites": {}}
    if set(suites) & set(LLM):
        from crew import ollama_pipeline
        report["model"] = getattr(ollama_pipeline, "OLLAMA_MODEL", None) or os.environ.get("OLLAMA_MODEL")
        print(f"LLM model: {report['model']}")
    for s in suites:
        t0 = time.time()
        if s == "normalization":
            r = eval_normalization()
        elif s == "retrieval":
            r = eval_retrieval()
        elif s == "reasoning":
            r = eval_reasoning()
        elif s == "paths":
            r = eval_paths()
        elif s in LLM:
            r = asyncio.run(eval_llm(s, max(1, args.repeat)))
        else:
            print(f"unknown suite {s!r}")
            continue
        r["seconds"] = round(time.time() - t0, 1)
        report["suites"][s] = r

    out_dir = os.path.join(HERE, "results")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, time.strftime("%Y%m%d-%H%M%S") + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1, default=str)
    print(f"\nresults → {path}")


if __name__ == "__main__":
    main()

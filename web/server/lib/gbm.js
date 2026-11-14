// Small gradient-boosted decision trees (logistic loss) in plain JavaScript.
//
// Histogram-based like LightGBM/XGBoost-hist: every feature is bucketed into
// ≤32 quantile bins, trees are grown level-wise to a fixed depth, rows are
// sub-sampled per tree, and samples can carry weights (used to undo the
// down-sampling of never-burning desert cells). Each prediction can be
// explained with per-feature contributions (Saabas path attribution).

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function quantileEdges(values, nBins) {
  const v = Float64Array.from(values.filter((x) => Number.isFinite(x))).sort();
  const edges = [];
  for (let i = 1; i < nBins; i++) {
    const e = v[Math.floor((i / nBins) * (v.length - 1))];
    if (edges.length === 0 || e > edges[edges.length - 1]) edges.push(e);
  }
  return edges; // bin b = number of edges < value
}

function binOf(x, edges) {
  if (!Number.isFinite(x)) return 0;
  let lo = 0, hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x > edges[mid]) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * X: array of Float64Array rows, y: 0/1 array, w: weights.
 * Returns a JSON-serialisable model.
 */
export function trainGBM(X, y, w, featureNames, opts = {}) {
  const { nTrees = 200, depth = 5, lr = 0.08, subsample = 0.6, lambda = 1, minHess = 5, nBins = 32, log = () => {} } = opts;
  const n = X.length;
  const F = featureNames.length;
  const edges = featureNames.map((_, f) => quantileEdges(X.map((r) => r[f]), nBins));
  const bins = featureNames.map((_, f) => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = binOf(X[i][f], edges[f]);
    return b;
  });
  let sw = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    sw += w[i];
    sy += w[i] * y[i];
  }
  const base = Math.log(sy / (sw - sy));
  const raw = new Float64Array(n).fill(base);
  const g = new Float64Array(n);
  const h = new Float64Array(n);
  const nodeOf = new Int32Array(n);
  const importance = new Float64Array(F);
  const trees = [];
  const maxNodes = 2 ** (depth + 1);

  for (let t = 0; t < nTrees; t++) {
    for (let i = 0; i < n; i++) {
      const p = sigmoid(raw[i]);
      g[i] = (p - y[i]) * w[i];
      h[i] = Math.max(p * (1 - p), 1e-6) * w[i];
      nodeOf[i] = Math.random() < subsample ? 0 : -1; // -1 = not in this tree's sample
    }
    // nodes: {f, bin, thr, l, r, v, G, H}
    const nodes = [{ G: 0, H: 0 }];
    for (let i = 0; i < n; i++) if (nodeOf[i] === 0) {
      nodes[0].G += g[i];
      nodes[0].H += h[i];
    }
    let frontier = [0];
    for (let d = 0; d < depth && frontier.length; d++) {
      // histograms for every frontier node
      const idx = new Map(frontier.map((nd, k) => [nd, k]));
      const HG = new Float64Array(frontier.length * F * nBins);
      const HH = new Float64Array(frontier.length * F * nBins);
      for (let i = 0; i < n; i++) {
        const k = idx.get(nodeOf[i]);
        if (k === undefined) continue;
        const gi = g[i], hi = h[i];
        const baseK = k * F * nBins;
        for (let f = 0; f < F; f++) {
          const o = baseK + f * nBins + bins[f][i];
          HG[o] += gi;
          HH[o] += hi;
        }
      }
      const next = [];
      frontier.forEach((nd, k) => {
        const node = nodes[nd];
        const parentScore = (node.G * node.G) / (node.H + lambda);
        let best = null;
        for (let f = 0; f < F; f++) {
          let gl = 0, hl = 0;
          const o = k * F * nBins + f * nBins;
          for (let b = 0; b < edges[f].length; b++) {
            gl += HG[o + b];
            hl += HH[o + b];
            const gr = node.G - gl, hr = node.H - hl;
            if (hl < minHess || hr < minHess) continue;
            const gain = (gl * gl) / (hl + lambda) + (gr * gr) / (hr + lambda) - parentScore;
            if (!best || gain > best.gain) best = { f, b, gain, gl, hl, gr, hr };
          }
        }
        if (!best || best.gain <= 1e-9 || nodes.length + 2 > maxNodes) return;
        importance[best.f] += best.gain;
        node.f = best.f;
        node.bin = best.b;
        node.thr = edges[best.f][best.b];
        node.l = nodes.length;
        nodes.push({ G: best.gl, H: best.hl });
        node.r = nodes.length;
        nodes.push({ G: best.gr, H: best.hr });
        next.push(node.l, node.r);
      });
      // route sampled rows to children
      for (let i = 0; i < n; i++) {
        const nd = nodeOf[i];
        if (nd < 0) continue;
        const node = nodes[nd];
        if (node.f === undefined) continue;
        nodeOf[i] = bins[node.f][i] <= node.bin ? node.l : node.r;
      }
      frontier = next;
    }
    // node values (expected contribution) – leaves are what we add; inner values allow explanations
    for (const node of nodes) node.v = (-node.G / (node.H + lambda)) * lr;
    const tree = nodes.map((nd) => (nd.f === undefined ? { v: +nd.v.toFixed(6) } : { f: nd.f, t: nd.thr, l: nd.l, r: nd.r, v: +nd.v.toFixed(6) }));
    trees.push(tree);
    // update all rows (not just the sample)
    for (let i = 0; i < n; i++) raw[i] += predictTreeBinned(tree, X[i]);
    if ((t + 1) % 25 === 0) log(`  tree ${t + 1}/${nTrees}  logloss ${logloss(raw, y, w).toFixed(4)}`);
  }
  const total = importance.reduce((a, b) => a + b, 0) || 1;
  return {
    base,
    trees,
    features: featureNames,
    importance: Object.fromEntries(featureNames.map((f, i) => [f, +(importance[i] / total).toFixed(4)])),
    params: { nTrees, depth, lr, subsample, lambda, minHess, nBins },
  };
}

function predictTreeBinned(tree, x) {
  let nd = 0;
  while (tree[nd].f !== undefined) nd = !(x[tree[nd].f] > tree[nd].t) ? tree[nd].l : tree[nd].r;
  return tree[nd].v;
}

function logloss(raw, y, w) {
  let s = 0, sw = 0;
  for (let i = 0; i < raw.length; i++) {
    const p = Math.min(1 - 1e-7, Math.max(1e-7, sigmoid(raw[i])));
    s -= w[i] * (y[i] ? Math.log(p) : Math.log(1 - p));
    sw += w[i];
  }
  return s / sw;
}

export function predictProba(model, x) {
  let s = model.base;
  for (const tree of model.trees) s += predictTreeBinned(tree, x);
  return sigmoid(s);
}

// Per-feature contributions on the log-odds scale (Saabas): along each tree path,
// the change in node value is credited to the feature that made the split.
export function explain(model, x) {
  const contrib = new Float64Array(model.features.length);
  let s = model.base;
  for (const tree of model.trees) {
    let nd = 0;
    s += tree[0].v;
    while (tree[nd].f !== undefined) {
      const next = !(x[tree[nd].f] > tree[nd].t) ? tree[nd].l : tree[nd].r;
      contrib[tree[nd].f] += tree[next].v - tree[nd].v;
      s += tree[next].v - tree[nd].v;
      nd = next;
    }
  }
  return { p: sigmoid(s), contrib: Object.fromEntries(model.features.map((f, i) => [f, contrib[i]])) };
}

// ---------- evaluation ----------
export function auc(scores, labels) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rank = 0, pos = 0, sumRanks = 0;
  for (let k = 0; k < idx.length; k++) {
    rank = k + 1;
    if (labels[idx[k]]) {
      pos++;
      sumRanks += rank;
    }
  }
  const neg = labels.length - pos;
  return pos && neg ? (sumRanks - (pos * (pos + 1)) / 2) / (pos * neg) : null;
}

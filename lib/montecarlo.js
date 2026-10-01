// Monte Carlo election simulation.
//
// Converts per-candidate vote-share estimates (mean + uncertainty) into true
// win probabilities: P(candidate finishes first).
//
// Model: each simulated election draws every candidate's vote share from an
// independent Normal(mean, sd), truncated at 0. The winner of a simulation is
// the argmax. Argmax is scale-invariant, so no renormalization is needed —
// only the ordering matters, which is exactly what P(win) requires.
//
// Uncertainty (sd) comes from the research confidence level: high-confidence
// estimates get a tight distribution, low-confidence ones a wide one.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard normal via Box-Muller.
function randn(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function sdForConfidence(confidence) {
  if (confidence === 'high') return 2.5;
  if (confidence === 'medium') return 4.5;
  return 7; // low or unknown
}

// --- Forecast-horizon uncertainty -------------------------------------------
// A vote-share estimate's sd only captures how sure the research is *today*.
// Campaigns move numbers: the further away the election, the wider the true
// forecast distribution. Without this, a 'high'-confidence estimate months
// out collapses to a near-100% win probability, which is never honest —
// a 10-point lead 5 months out is worth low-80s, not 99.7%.
// Nominal date of the next Goa assembly election (Goa voted Feb 2022; the
// 5-year term ends early 2027). Only used to scale uncertainty, never shown.
const ELECTION_DATE_UTC = Date.UTC(2027, 1, 15);

function monthsToElection(nowMs = Date.now()) {
  return Math.max(0, (ELECTION_DATE_UTC - nowMs) / (30.44 * 864e5));
}

// ~±1.5pts of campaign movement per remaining month, floored at 2 (even on
// election eve polls can be off) and capped at 8.
function horizonSd(months = monthsToElection()) {
  return Math.min(8, Math.max(2, months * 1.5));
}

// Total forecast sd: estimate uncertainty ⊕ campaign uncertainty.
function effectiveSd(baseSd, months = monthsToElection()) {
  const h = horizonSd(months);
  return Math.sqrt(baseSd * baseSd + h * h);
}

const BINS = 24;      // histogram bins for the vote-share distribution plot
const BIN_MAX = 60;   // x-axis covers 0..60% vote share

// candidates: [{ id, vote_share_mean, vote_share_sd }]
// returns: [{ id, win_probability (0-100), mc_bins, mc_n }]
function simulate(candidates, n = 10000, seed) {
  const cands = (candidates || [])
    .map((c) => ({
      id: c.id,
      mean: Math.max(0.5, Math.min(70, +c.vote_share_mean || 0)),
      sd: Math.max(1, Math.min(15, +c.vote_share_sd || sdForConfidence(c.confidence))),
    }))
    .filter((c) => c.mean > 0);
  if (!cands.length) return [];
  const rng = mulberry32(seed === undefined ? (Date.now() % 2147483647) : seed);
  const wins = new Array(cands.length).fill(0);
  const hists = cands.map(() => new Array(BINS).fill(0));
  for (let s = 0; s < n; s++) {
    let best = 0, bestV = -Infinity;
    for (let i = 0; i < cands.length; i++) {
      let v = cands[i].mean + cands[i].sd * randn(rng);
      if (v < 0) v = 0;
      const b = Math.min(BINS - 1, Math.floor((v / BIN_MAX) * BINS));
      hists[i][b]++;
      if (v > bestV) { bestV = v; best = i; }
    }
    wins[best]++;
  }
  return cands.map((c, i) => ({
    id: c.id,
    win_probability: (wins[i] / n) * 100,
    mc_bins: hists[i],
    mc_n: n,
  }));
}

module.exports = { simulate, sdForConfidence, monthsToElection, horizonSd, effectiveSd, BINS, BIN_MAX };

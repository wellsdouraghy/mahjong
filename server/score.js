'use strict';

// Chinese Official (MCR) scoring engine.
// See SCORING.md for the compiled 82-fan spec (source of truth).
//
// scoreHand(concealedTiles, melds, ctx) -> { total, fans: [{name, points}] }
//   concealedTiles: array of kind strings (14 - 3*meldCount tiles, incl. winning tile)
//   melds:  [{ type: "pon" | "chi", tiles: [kind, kind, kind] }]
//   ctx:    { selfDrawn, seatWind (kind|null), fullyConcealed, lastWallTile,
//             winningTile (kind), isDealer }
//
// The engine enumerates every valid decomposition (standard 4 sets + pair, plus
// the seven-pairs / knitted / thirteen-orphans / nine-gates specials), scores
// each against the fan table with the doc's exclusion / implied-point rules, and
// returns the highest-scoring interpretation.

// ---------------------------------------------------------------------------
// Tile index model (matches server/game.js KINDS ordering)
//   m1..m9 = 0..8, p1..p9 = 9..17, s1..s9 = 18..26,
//   wE,wS,wW,wN = 27..30, dR,dG,dW = 31..33
// ---------------------------------------------------------------------------
const KINDS = [];
for (const s of ['m', 'p', 's']) for (let r = 1; r <= 9; r++) KINDS.push(s + r);
for (const w of ['E', 'S', 'W', 'N']) KINDS.push('w' + w);
for (const d of ['R', 'G', 'W']) KINDS.push('d' + d);
const KIND_INDEX = Object.create(null);
KINDS.forEach((k, i) => { KIND_INDEX[k] = i; });

const suitOfIdx = (i) => (i < 9 ? 'm' : i < 18 ? 'p' : i < 27 ? 's' : i < 31 ? 'w' : 'd');
const isSuited = (i) => i < 27;
const rankOfIdx = (i) => (i < 27 ? (i % 9) + 1 : 0);
const isHonorIdx = (i) => i >= 27;
const isDragonIdx = (i) => i >= 31;
const isWindIdx = (i) => i >= 27 && i <= 30;
const isTerminalIdx = (i) => isSuited(i) && (rankOfIdx(i) === 1 || rankOfIdx(i) === 9);
const isTermHonorIdx = (i) => isHonorIdx(i) || isTerminalIdx(i);
const isRunStartIdx = (i) => i < 27 && (i % 9) <= 6;

const GREEN_SET = new Set([19, 20, 21, 23, 25, 32]);           // s2 s3 s4 s6 s8 dG
const REVERSIBLE_SET = new Set([19, 21, 22, 23, 25, 26,        // s2 s4 s5 s6 s8 s9
  9, 10, 11, 12, 13, 16, 17,                                   // p1 p2 p3 p4 p5 p8 p9
  33]);                                                        // dW

// ---------------------------------------------------------------------------
// Fan table: id -> { name, points }
// ---------------------------------------------------------------------------
const FAN = {
  1: ['Pure Double Chow', 1],
  2: ['Mixed Double Chow', 1],
  3: ['Short Straight', 1],
  4: ['Two Terminal Chows', 1],
  5: ['Pung of Terminals or Honors', 1],
  6: ['Melded Kong', 1],
  7: ['One Voided Suit', 1],
  8: ['No Honors', 1],
  9: ['Edge Wait', 1],
  10: ['Closed Wait', 1],
  11: ['Single Wait', 1],
  12: ['Self-Drawn', 1],
  14: ['Dragon Pung', 2],
  15: ['Prevalent Wind', 2],
  16: ['Seat Wind', 2],
  17: ['Concealed Hand', 2],
  18: ['All Chows', 2],
  19: ['Tile Hog', 2],
  20: ['Double Pung', 2],
  21: ['Two Concealed Pungs', 2],
  22: ['Concealed Kong', 2],
  23: ['All Simples', 2],
  24: ['Outside Hand', 4],
  25: ['Fully Concealed Hand', 4],
  26: ['Two Melded Kongs', 4],
  28: ['All Pungs', 6],
  29: ['Half Flush', 6],
  30: ['Mixed Shifted Chows', 6],
  31: ['All Types', 6],
  32: ['Melded Hand', 6],
  33: ['Two Dragons', 6],
  34: ['One Melded and One Concealed Kong', 6],
  35: ['Mixed Straight', 8],
  36: ['Reversible Tiles', 8],
  37: ['Mixed Triple Chow', 8],
  38: ['Mixed Shifted Pungs', 8],
  40: ['Last Tile Draw', 8],
  41: ['Last Tile Claim', 8],
  42: ['Out with Replacement Tile', 8],
  43: ['Two Concealed Kongs', 8],
  44: ['Robbing the Kong', 8],
  45: ['Lesser Honors and Knitted Tiles', 12],
  46: ['Knitted Straight', 12],
  47: ['Upper Four', 12],
  48: ['Lower Four', 12],
  49: ['Big Three Winds', 12],
  50: ['Pure Straight', 16],
  51: ['Three-Suited Terminal Chows', 16],
  52: ['Pure Shifted Chows', 16],
  53: ['All Fives', 16],
  54: ['Triple Pung', 16],
  55: ['Three Concealed Pungs', 16],
  56: ['Seven Pairs', 24],
  57: ['Greater Honors and Knitted Tiles', 24],
  58: ['All Even', 24],
  59: ['Full Flush', 24],
  60: ['Pure Triple Chow', 24],
  61: ['Pure Shifted Pungs', 24],
  62: ['Upper Tiles', 24],
  63: ['Middle Tiles', 24],
  64: ['Lower Tiles', 24],
  65: ['Four Shifted Chows', 32],
  66: ['Three Kongs', 32],
  67: ['All Terminals and Honors', 32],
  68: ['Quadruple Chow', 48],
  69: ['Four Pure Shifted Pungs', 48],
  70: ['All Terminals', 64],
  71: ['Little Four Winds', 64],
  72: ['Little Three Dragons', 64],
  73: ['All Honors', 64],
  74: ['Four Concealed Pungs', 64],
  75: ['Pure Terminal Chows', 64],
  76: ['Big Four Winds', 88],
  77: ['Big Three Dragons', 88],
  78: ['All Green', 88],
  79: ['Nine Gates', 88],
  80: ['Four Kongs', 88],
  81: ['Seven Shifted Pairs', 88],
  82: ['Thirteen Orphans', 88],
};

function fan(id) { return { id, name: FAN[id][0], points: FAN[id][1] }; }

// Implication / exclusion table: when key fan is present, remove listed fans.
// Drawn from SCORING.md section 4 (explicit "does not combine" / "implied")
// plus standard MCR non-repeat gap-fills.
const IMPLIES = {
  36: [7],                    // Reversible -> One Voided
  58: [28, 23, 8],            // All Even -> All Pungs, All Simples (+No Honors)
  59: [8],                    // Full Flush -> No Honors
  62: [8], 63: [8, 23], 64: [8], 47: [8], 48: [8],
  67: [28, 5, 24, 8],         // All Terminals & Honors -> All Pungs, Pung T/H, Outside, No Honors
  68: [61, 19, 1, 60, 3, 52], // Quadruple Chow -> Shifted Pungs, Tile Hog, Pure Double Chow, ...
  69: [61, 38, 20],           // Four Pure Shifted Pungs -> Pure/Mixed Shifted Pungs, Double Pung
  70: [20, 8, 28, 5, 24],     // All Terminals -> Double Pung, No Honors, All Pungs, Pung T/H, Outside
  71: [49],                   // Little Four Winds -> Big Three Winds (keeps Seat Wind)
  72: [14, 33],               // Little Three Dragons -> Dragon Pung, Two Dragons
  73: [28, 5, 24],            // All Honors -> All Pungs, Pung T/H, Outside (keeps Dragon Pung)
  74: [25, 28, 21, 55],       // Four Concealed Pungs -> Fully Concealed, All Pungs, 2/3 Concealed
  76: [28, 49, 16, 15, 5],    // Big Four Winds -> All Pungs, Big Three Winds, Seat+Prevalent Wind, Pung T/H
  77: [14, 33],               // Big Three Dragons -> Dragon Pung, Two Dragons
  79: [59, 5],                // Nine Gates -> Full Flush, Pung T/H
  82: [31, 17, 11],           // Thirteen Orphans
  56: [17, 11],               // Seven Pairs
  57: [31, 17, 11],           // Greater Honors & Knitted
  50: [3, 4],                 // Pure Straight -> Short Straight, Two Terminal Chows
  37: [2],                    // Mixed Triple Chow -> Mixed Double Chow
  60: [1, 61],                // Pure Triple Chow -> Pure Double Chow (excl. Pure Shifted Pungs)
  54: [20],                   // Triple Pung -> Double Pung
  65: [52],                   // Four Shifted Chows -> Pure Shifted Chows
  55: [21],                   // Three Concealed Pungs -> Two Concealed Pungs
  51: [4, 1, 8],              // Three-suited Terminal Chows -> Two Terminal Chows, No Honors
  75: [4, 1, 8],              // Pure Terminal Chows -> Two Terminal Chows, Pure Double Chow, No Honors
  40: [12],                   // Last Tile Draw -> Self-Drawn
  42: [12],                   // Out with Replacement Tile -> Self-Drawn (the replacement is the draw)
  32: [11],                   // Melded Hand -> Single Wait
};

// ---------------------------------------------------------------------------
// Decomposition enumeration
// ---------------------------------------------------------------------------
function toCounts(kinds) {
  const c = new Array(34).fill(0);
  for (const k of kinds) {
    const idx = KIND_INDEX[k];
    if (idx === undefined) continue;
    c[idx]++;
  }
  return c;
}

// Enumerate every way to remove exactly n sets (pung/chow) from counts.
// Always consumes the lowest nonzero index -> no permutation duplicates.
function setDecomps(counts, n) {
  if (n === 0) {
    for (let i = 0; i < 34; i++) if (counts[i] !== 0) return [];
    return [[]];
  }
  let i = 0;
  while (i < 34 && counts[i] === 0) i++;
  if (i === 34) return [];
  const out = [];
  if (counts[i] >= 3) {
    counts[i] -= 3;
    for (const rest of setDecomps(counts, n - 1)) out.push([{ t: 'pung', i }, ...rest]);
    counts[i] += 3;
  }
  if (isRunStartIdx(i) && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i]--; counts[i + 1]--; counts[i + 2]--;
    for (const rest of setDecomps(counts, n - 1)) out.push([{ t: 'chow', i }, ...rest]);
    counts[i]++; counts[i + 1]++; counts[i + 2]++;
  }
  return out;
}

// Standard decompositions: choose a pair, split the rest into needSets sets.
function fullDecomps(counts, needSets) {
  const res = [];
  for (let p = 0; p < 34; p++) {
    if (counts[p] >= 2) {
      counts[p] -= 2;
      for (const sets of setDecomps(counts, needSets)) res.push({ sets, pairIdx: p });
      counts[p] += 2;
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Group helpers
// ---------------------------------------------------------------------------
function meldToGroup(meld) {
  const idxs = meld.tiles.map((k) => KIND_INDEX[k]).sort((a, b) => a - b);
  if (meld.type === 'chi') return { t: 'chow', i: idxs[0], concealed: false };
  // A concealed kong is a concealed set for pattern/concealment purposes; a melded
  // kong or a claimed pung is exposed. (A kong scores as its pung set.)
  const concealed = meld.type === 'kong' ? !!meld.concealed : false;
  return { t: 'pung', i: idxs[0], concealed };
}

// group tiles (as idx list)
function groupTiles(g) {
  if (g.t === 'chow') return [g.i, g.i + 1, g.i + 2];
  if (g.t === 'pung') return [g.i, g.i, g.i];
  return [g.i, g.i]; // pair
}

// ---------------------------------------------------------------------------
// Whole-hand pattern fans (flush / rank-range / honor family). Reusable across
// standard hands and Seven Pairs.
// ---------------------------------------------------------------------------
function wholeHandFans(counts, present) {
  // present: Set of idx with count>0
  const idxs = [...present];
  const suits = new Set();
  let honors = false;
  for (const i of idxs) {
    if (isHonorIdx(i)) honors = true;
    else suits.add(suitOfIdx(i));
  }
  const out = [];
  const all = (pred) => idxs.every(pred);

  // Flush family
  if (suits.size === 2) out.push(fan(7));                  // One Voided Suit
  if (suits.size === 1 && honors) out.push(fan(29));       // Half Flush
  if (suits.size === 1 && !honors) out.push(fan(59));      // Full Flush
  if (!honors) out.push(fan(8));                           // No Honors

  // All Green / Reversible
  if (all((i) => GREEN_SET.has(i))) out.push(fan(78));
  if (all((i) => REVERSIBLE_SET.has(i))) out.push(fan(36));

  // Honor / terminal families
  if (all(isHonorIdx)) out.push(fan(73));                          // All Honors
  else if (all(isTermHonorIdx) && honors) out.push(fan(67));       // All Terminals and Honors
  else if (all((i) => isSuited(i) && (rankOfIdx(i) === 1 || rankOfIdx(i) === 9))) out.push(fan(70)); // All Terminals

  // Rank-range families (suited only)
  if (!honors) {
    const inRange = (set) => all((i) => set.has(rankOfIdx(i)));
    const R = (arr) => new Set(arr);
    if (inRange(R([1, 2, 3]))) out.push(fan(64));        // Lower Tiles
    else if (inRange(R([4, 5, 6]))) out.push(fan(63));   // Middle Tiles
    else if (inRange(R([7, 8, 9]))) out.push(fan(62));   // Upper Tiles
    else if (inRange(R([1, 2, 3, 4]))) out.push(fan(48)); // Lower Four
    else if (inRange(R([6, 7, 8, 9]))) out.push(fan(47)); // Upper Four
    if (all((i) => rankOfIdx(i) >= 2 && rankOfIdx(i) <= 8)) out.push(fan(23)); // All Simples
  }
  return out;
}

// ---------------------------------------------------------------------------
// Context fans (concealment / self-draw / last tile). Seat wind + waits are
// handled inside the decomposition scorer.
// ---------------------------------------------------------------------------
function contextFans(ctx, meldCount, excludeConcealedHand) {
  const out = [];
  if (ctx.selfDrawn) {
    if (ctx.replacementWin) out.push(fan(42));   // Out with Replacement Tile (kong replacement)
    if (ctx.lastWallTile) out.push(fan(40)); else out.push(fan(12));
    if (meldCount === 0) out.push(fan(25));
  } else {
    if (ctx.robbingKong) out.push(fan(44));       // Robbing the Kong (won on the added-kong tile)
    if (ctx.lastWallTile) out.push(fan(41));
    if (meldCount === 0 && !excludeConcealedHand) out.push(fan(17));
  }
  return out;
}

// Kong bonus fans, derived from the declared kong melds (independent of the
// chosen decomposition — a kong already scores as its pung set elsewhere).
function kongFans(meldedKongs, concealedKongs) {
  const out = [];
  const total = meldedKongs + concealedKongs;
  if (total >= 4) { out.push(fan(80)); return out; }        // Four Kongs
  if (total === 3) { out.push(fan(66)); return out; }       // Three Kongs
  if (total === 2) {
    if (meldedKongs === 2) out.push(fan(26));               // Two Melded Kongs
    else if (concealedKongs === 2) out.push(fan(43));       // Two Concealed Kongs
    else out.push(fan(34));                                 // One Melded and One Concealed Kong
    return out;
  }
  if (total === 1) {
    if (meldedKongs === 1) out.push(fan(6));                // Melded Kong
    else out.push(fan(22));                                 // Concealed Kong
  }
  return out;
}

// ---------------------------------------------------------------------------
// Score one standard decomposition (4 sets + pair).
// ---------------------------------------------------------------------------
function scoreStandard(sets, pairIdx, ctx, meldCount, winIdx) {
  const out = [];
  const allIdx = [];
  for (const g of sets) allIdx.push(...groupTiles(g));
  allIdx.push(pairIdx, pairIdx);
  const present = new Set(allIdx);

  // Concealment is measured by EXPOSED sets only: claimed pungs/chows and melded
  // kongs are exposed; concealed kongs (and undeclared sets) keep the hand
  // concealed. This drives the Concealed / Fully Concealed / Melded Hand fans.
  const exposedCount = sets.filter((g) => !g.concealed).length;

  const chows = sets.filter((g) => g.t === 'chow');
  const pungs = sets.filter((g) => g.t === 'pung');
  const suitedPungs = pungs.filter((g) => isSuited(g.i));
  const seatWindIdx = ctx.seatWind != null ? KIND_INDEX[ctx.seatWind] : -1;
  const roundWindIdx = ctx.roundWind != null ? KIND_INDEX[ctx.roundWind] : -1;

  // ---- whole-hand pattern fans -----------------------------------------
  out.push(...wholeHandFans(toCounts(allIdx.map((i) => KINDS[i])), present));

  // ---- All Chows / All Pungs -------------------------------------------
  const honorsPresent = allIdx.some(isHonorIdx);
  if (chows.length === 4 && !honorsPresent) out.push(fan(18)); // All Chows
  if (pungs.length === 4) out.push(fan(28));                   // All Pungs

  // ---- Melded Hand: all 4 sets claimed, ron completing the pair --------
  if (exposedCount === 4 && !ctx.selfDrawn && winIdx === pairIdx) out.push(fan(32));

  // ---- All Types --------------------------------------------------------
  const groupTypes = new Set();
  for (const g of sets) groupTypes.add(suitOfIdx(g.i));
  groupTypes.add(suitOfIdx(pairIdx));
  if (groupTypes.size === 5) out.push(fan(31)); // one each of m,p,s,w,d

  // ---- Outside Hand -----------------------------------------------------
  const groupOutside = (g) => {
    if (g.t === 'chow') return g.i % 9 === 0 || g.i % 9 === 6; // 123 or 789
    return isTermHonorIdx(g.i);
  };
  if (sets.every(groupOutside) && isTermHonorIdx(pairIdx)) out.push(fan(24));

  // ---- All Fives --------------------------------------------------------
  const groupHasFive = (g) => {
    if (g.t === 'chow') { const l = rankOfIdx(g.i); return l >= 3 && l <= 5; }
    return isSuited(g.i) && rankOfIdx(g.i) === 5;
  };
  if (sets.every(groupHasFive) && isSuited(pairIdx) && rankOfIdx(pairIdx) === 5) out.push(fan(53));

  // ---- All Even ---------------------------------------------------------
  if (pungs.length === 4 && allIdx.every((i) => isSuited(i) && rankOfIdx(i) % 2 === 0)) out.push(fan(58));

  // ---- Dragons ----------------------------------------------------------
  const dragonPungs = pungs.filter((g) => isDragonIdx(g.i));
  const windPungs = pungs.filter((g) => isWindIdx(g.i));
  const pairIsDragon = isDragonIdx(pairIdx);
  const pairIsWind = isWindIdx(pairIdx);
  if (dragonPungs.length === 3) out.push(fan(77));
  else if (dragonPungs.length === 2 && pairIsDragon) out.push(fan(72));
  else if (dragonPungs.length === 2) out.push(fan(33));
  else if (dragonPungs.length === 1) out.push(fan(14));

  // ---- Winds ------------------------------------------------------------
  if (windPungs.length === 4) out.push(fan(76));
  else if (windPungs.length === 3 && pairIsWind) out.push(fan(71));
  else if (windPungs.length === 3) out.push(fan(49));
  // Seat wind
  if (windPungs.some((g) => g.i === seatWindIdx)) out.push(fan(16));
  // Prevalent (round) wind — a pung of the round wind scores independently of
  // seat wind, so East seat in the East round scores BOTH.
  if (roundWindIdx >= 0 && windPungs.some((g) => g.i === roundWindIdx)) out.push(fan(15));

  // ---- Pung of Terminals or Honors (per pung) --------------------------
  //   terminal pungs (1/9) and guest-wind pungs (winds != seat wind).
  for (const g of pungs) {
    if (isTerminalIdx(g.i)) out.push(fan(5));
    else if (isWindIdx(g.i) && g.i !== seatWindIdx && g.i !== roundWindIdx) out.push(fan(5));
  }

  // ---- Concealed pungs --------------------------------------------------
  let concealedPungs = pungs.filter((g) => g.concealed).length;
  // A pung completed by a ron discard is treated as melded (standard MCR).
  if (!ctx.selfDrawn && winIdx >= 0) {
    const ronPung = pungs.find((g) => g.concealed && g.i === winIdx);
    if (ronPung) concealedPungs--;
  }
  if (concealedPungs >= 4) out.push(fan(74));
  else if (concealedPungs === 3) out.push(fan(55));
  else if (concealedPungs === 2) out.push(fan(21));

  // ---- Tile Hog (suit tile used 4x, not a kong) ------------------------
  const counts = toCounts(allIdx.map((i) => KINDS[i]));
  for (let i = 0; i < 27; i++) if (counts[i] === 4) out.push(fan(19));

  // ---- Chow combination fans -------------------------------------------
  scoreChowFans(chows, out);

  // ---- Pung combination fans (same-number) -----------------------------
  scorePungFans(suitedPungs, out);

  // ---- Three-suited Terminal Chows / Pure Terminal Chows ---------------
  scoreTerminalChows(chows, pairIdx, out);

  // ---- Waits ------------------------------------------------------------
  if (winIdx >= 0) {
    const w = waitFan(sets, pairIdx, winIdx);
    if (w) out.push(fan(w));
  }

  // ---- Kong bonus fans --------------------------------------------------
  out.push(...kongFans(ctx.meldedKongs || 0, ctx.concealedKongs || 0));

  // ---- Context ----------------------------------------------------------
  out.push(...contextFans(ctx, exposedCount, false));

  return resolve(out);
}

// Chow-pattern fans over the chow sets.
function scoreChowFans(chows, out) {
  const list = chows.map((g) => ({ suit: suitOfIdx(g.i), low: rankOfIdx(g.i) }));
  const n = list.length;

  // Pairwise 1-pt fans
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const A = list[a], B = list[b];
      if (A.suit === B.suit) {
        if (A.low === B.low) out.push(fan(1));                 // Pure Double Chow
        else if (Math.abs(A.low - B.low) === 3) out.push(fan(3)); // Short Straight
        if ((A.low === 1 && B.low === 7) || (A.low === 7 && B.low === 1)) out.push(fan(4)); // Two Terminal Chows
      } else if (A.low === B.low) {
        out.push(fan(2));                                      // Mixed Double Chow
      }
    }
  }

  const bySuit = { m: [], p: [], s: [] };
  for (const c of list) bySuit[c.suit].push(c.low);
  for (const k of Object.keys(bySuit)) bySuit[k].sort((x, y) => x - y);

  // Four-chow fans (same suit)
  for (const suit of ['m', 'p', 's']) {
    const lows = bySuit[suit];
    if (lows.length === 4) {
      if (lows.every((l) => l === lows[0])) out.push(fan(68)); // Quadruple Chow
      else if (isArith(lows, 1)) out.push(fan(65));            // Four Shifted Chows (+1)
      else if (isArith(lows, 2)) out.push(fan(65));            // Four Shifted Chows (+2)
    }
  }

  // Three-chow same-suit fans
  for (const suit of ['m', 'p', 's']) {
    const lows = bySuit[suit];
    const combos = choose3(lows);
    for (const t of combos) {
      if (t[0] === t[1] && t[1] === t[2]) out.push(fan(60));               // Pure Triple Chow
      else if (sameSet(t, [1, 4, 7])) out.push(fan(50));                   // Pure Straight
      else if (isArith(t, 1) || isArith(t, 2)) out.push(fan(52));          // Pure Shifted Chows
    }
  }

  // Cross-suit three-chow fans (one per suit)
  const triLows = crossSuitTriples(bySuit);
  for (const t of triLows) {
    const s = [t.m, t.p, t.s].sort((x, y) => x - y);
    if (t.m === t.p && t.p === t.s) out.push(fan(37));                    // Mixed Triple Chow
    else if (sameSet(s, [1, 4, 7])) out.push(fan(35));                   // Mixed Straight
    else if (isArith(s, 1)) out.push(fan(30));                           // Mixed Shifted Chows
  }
}

function scorePungFans(suitedPungs, out) {
  const list = suitedPungs.map((g) => ({ suit: suitOfIdx(g.i), rank: rankOfIdx(g.i) }));
  const bySuit = { m: [], p: [], s: [] };
  for (const p of list) bySuit[p.suit].push(p.rank);
  for (const k of Object.keys(bySuit)) bySuit[k].sort((x, y) => x - y);

  // Same-suit consecutive pungs
  for (const suit of ['m', 'p', 's']) {
    const rk = bySuit[suit];
    if (rk.length === 4 && isArith(rk, 1)) out.push(fan(69));  // Four Pure Shifted Pungs
    for (const t of choose3(rk)) if (isArith(t, 1)) out.push(fan(61)); // Pure Shifted Pungs
  }

  // Cross-suit (one per suit): Triple Pung / Mixed Shifted Pungs / Double Pung
  const tri = crossSuitTriples(bySuit);
  let tripleOrShifted = false;
  for (const t of tri) {
    const s = [t.m, t.p, t.s].sort((x, y) => x - y);
    if (t.m === t.p && t.p === t.s) { out.push(fan(54)); tripleOrShifted = true; }  // Triple Pung
    else if (isArith(s, 1)) { out.push(fan(38)); tripleOrShifted = true; }          // Mixed Shifted Pungs
  }
  // Double Pung: two pungs same rank, different suits (only if not part of triple pung)
  if (!tripleOrShifted) {
    const seen = {};
    for (const p of list) { (seen[p.rank] = seen[p.rank] || new Set()).add(p.suit); }
    for (const r of Object.keys(seen)) if (seen[r].size >= 2) out.push(fan(20));
  }
}

function scoreTerminalChows(chows, pairIdx, out) {
  const list = chows.map((g) => ({ suit: suitOfIdx(g.i), low: rankOfIdx(g.i) }));
  const bySuit = { m: [], p: [], s: [] };
  for (const c of list) bySuit[c.suit].push(c.low);
  // Pure Terminal Chows: one suit 123,123,789,789 + pair of 5 same suit
  for (const suit of ['m', 'p', 's']) {
    const lows = bySuit[suit].slice().sort((a, b) => a - b);
    if (lows.length === 4 && lows[0] === 1 && lows[1] === 1 && lows[2] === 7 && lows[3] === 7 &&
        suitOfIdx(pairIdx) === suit && rankOfIdx(pairIdx) === 5) {
      out.push(fan(75));
    }
  }
  // Three-suited Terminal Chows: 123+789 in two suits, pair of 5 in third
  const has = (suit, low) => bySuit[suit].includes(low);
  const suitsWithBoth = ['m', 'p', 's'].filter((su) => has(su, 1) && has(su, 7) && bySuit[su].length === 2);
  if (suitsWithBoth.length === 2 && isSuited(pairIdx) && rankOfIdx(pairIdx) === 5) {
    const third = ['m', 'p', 's'].find((su) => !suitsWithBoth.includes(su));
    if (suitOfIdx(pairIdx) === third) out.push(fan(51));
  }
}

// Wait fan id (or null) given the group completed by winIdx.
function waitFan(sets, pairIdx, winIdx) {
  if (pairIdx === winIdx) return 11; // Single Wait (tanki)
  let best = null;
  for (const g of sets) {
    if (g.t === 'chow') {
      const low = rankOfIdx(g.i);
      const r = rankOfIdx(winIdx);
      if (suitOfIdx(g.i) !== suitOfIdx(winIdx)) continue;
      if (r < low || r > low + 2) continue;
      if (r === low + 1) best = best || 10;                              // Closed Wait
      else if ((low === 1 && r === 3) || (low === 7 && r === 7)) best = best || 9; // Edge Wait
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Exclusion resolution + total
// ---------------------------------------------------------------------------
function resolve(fans) {
  let ids = new Set(fans.map((f) => f.id));
  // Fixpoint removal.
  for (let iter = 0; iter < 4; iter++) {
    const remove = new Set();
    for (const id of ids) {
      const rem = IMPLIES[id];
      if (rem) for (const r of rem) if (id !== r) remove.add(r);
    }
    if (remove.size === 0) break;
    let changed = false;
    for (const r of remove) if (ids.has(r)) { ids.delete(r); changed = true; }
    if (!changed) break;
  }
  const kept = fans.filter((f) => ids.has(f.id));
  const total = kept.reduce((s, f) => s + f.points, 0);
  return { total, fans: kept.map((f) => ({ name: f.name, points: f.points })) };
}

// ---------------------------------------------------------------------------
// Arithmetic helpers
// ---------------------------------------------------------------------------
function isArith(arr, step) {
  const a = arr.slice().sort((x, y) => x - y);
  for (let i = 1; i < a.length; i++) if (a[i] - a[i - 1] !== step) return false;
  return true;
}
function sameSet(arr, target) {
  const a = arr.slice().sort((x, y) => x - y);
  const b = target.slice().sort((x, y) => x - y);
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
function choose3(arr) {
  const out = [];
  for (let a = 0; a < arr.length; a++)
    for (let b = a + 1; b < arr.length; b++)
      for (let c = b + 1; c < arr.length; c++)
        out.push([arr[a], arr[b], arr[c]]);
  return out;
}
// All (m,p,s) triples picking one low from each suit's list.
function crossSuitTriples(bySuit) {
  const res = [];
  for (const mi of bySuit.m) for (const pi of bySuit.p) for (const si of bySuit.s) {
    res.push({ m: mi, p: pi, s: si });
  }
  return res;
}

// ---------------------------------------------------------------------------
// Special hands (only when there are no melds).
// ---------------------------------------------------------------------------
const THIRTEEN = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

function scoreThirteenOrphans(counts, ctx) {
  let pair = -1, total = 0;
  for (let i = 0; i < 34; i++) {
    if (counts[i] === 0) continue;
    if (!THIRTEEN.includes(i)) return null;
    total += counts[i];
    if (counts[i] === 2) { if (pair !== -1) return null; pair = i; }
    else if (counts[i] !== 1) return null;
  }
  if (pair === -1 || total !== 14) return null;
  const out = [fan(82), ...contextFans(ctx, 0, true)];
  return resolve(out);
}

function scoreSevenShiftedPairs(counts, ctx) {
  const idxs = [];
  for (let i = 0; i < 34; i++) {
    if (counts[i] === 0) continue;
    if (counts[i] !== 2) return null;
    idxs.push(i);
  }
  if (idxs.length !== 7) return null;
  if (!isSuited(idxs[0])) return null;
  const suit = suitOfIdx(idxs[0]);
  if (!idxs.every((i) => suitOfIdx(i) === suit)) return null;
  const ranks = idxs.map(rankOfIdx).sort((a, b) => a - b);
  if (!isArith(ranks, 1)) return null;
  // Seven shifted pairs: 88. Combines with Fully Concealed / Self-drawn.
  const out = [fan(81), ...contextFans(ctx, 0, true)];
  return resolve(out);
}

function scoreSevenPairs(counts, ctx) {
  let pairs = 0;
  const present = new Set();
  for (let i = 0; i < 34; i++) {
    if (counts[i] === 0) continue;
    if (counts[i] !== 2) return null;
    pairs++; present.add(i);
  }
  if (pairs !== 7) return null;
  const out = [fan(56)];
  out.push(...wholeHandFans(counts, present));
  out.push(...contextFans(ctx, 0, true)); // excludes Concealed Hand (17)
  return resolve(out);
}

function scoreNineGates(counts, ctx, winIdx) {
  if (winIdx < 0) return null;
  // single suit, all 14 in it
  let suit = null, total = 0;
  for (let i = 0; i < 34; i++) {
    if (counts[i] === 0) continue;
    total += counts[i];
    const s = suitOfIdx(i);
    if (!isSuited(i)) return null;
    if (suit === null) suit = s; else if (suit !== s) return null;
  }
  if (total !== 14 || suit === null) return null;
  if (suitOfIdx(winIdx) !== suit) return null;
  const base = suit === 'm' ? 0 : suit === 'p' ? 9 : 18;
  const pattern = [3, 1, 1, 1, 1, 1, 1, 1, 3];
  const test = counts.slice(base, base + 9);
  test[rankOfIdx(winIdx) - 1]--; // remove winning tile -> must be pure 1112345678999
  for (let r = 0; r < 9; r++) if (test[r] !== pattern[r]) return null;
  const out = [fan(79), ...contextFans(ctx, 0, false)];
  return resolve(out);
}

// Knitted chains: 147, 258, 369 (rank sets), assigned to distinct suits.
const CHAINS = [[1, 4, 7], [2, 5, 8], [3, 6, 9]];

// Check suited singles fit a knitted assignment: each suit's ranks all belong to
// one chain, and the three suits use distinct chains.
function fitsKnitted(bySuitRanks) {
  const usedChains = new Set();
  for (const suit of ['m', 'p', 's']) {
    const ranks = bySuitRanks[suit];
    if (!ranks.length) continue;
    let chain = -1;
    for (let ci = 0; ci < 3; ci++) {
      if (ranks.every((r) => CHAINS[ci].includes(r))) { chain = ci; break; }
    }
    if (chain === -1) return false;
    if (usedChains.has(chain)) return false;
    usedChains.add(chain);
  }
  return true;
}

function scoreHonorsKnitted(counts, ctx) {
  // All singles (no pairs/sets), total 14.
  let total = 0, honorCount = 0;
  const bySuit = { m: [], p: [], s: [] };
  for (let i = 0; i < 34; i++) {
    if (counts[i] === 0) continue;
    if (counts[i] !== 1) return null;
    total++;
    if (isHonorIdx(i)) honorCount++;
    else bySuit[suitOfIdx(i)].push(rankOfIdx(i));
  }
  if (total !== 14) return null;
  if (!fitsKnitted(bySuit)) return null;
  if (honorCount === 7) {
    const out = [fan(57), ...contextFans(ctx, 0, true)]; // Greater: excl. Concealed Hand
    return resolve(out);
  }
  if (honorCount < 7) {
    const out = [fan(45), ...contextFans(ctx, 0, false)]; // Lesser
    return resolve(out);
  }
  return null;
}

function scoreKnittedStraight(counts, ctx) {
  // 1-9 as 147/258/369 across distinct suits (9 tiles) + set + pair from rest.
  for (const perm of PERMS3) {
    const work = counts.slice();
    let ok = true;
    const assign = { m: perm[0], p: perm[1], s: perm[2] };
    for (const suit of ['m', 'p', 's']) {
      const base = suit === 'm' ? 0 : suit === 'p' ? 9 : 18;
      for (const r of CHAINS[assign[suit]]) {
        if (work[base + r - 1] < 1) { ok = false; break; }
        work[base + r - 1]--;
      }
      if (!ok) break;
    }
    if (!ok) continue;
    // remaining 5 tiles must be one set + one pair
    const decs = fullDecomps(work, 1);
    if (decs.length > 0) {
      const out = [fan(46), ...contextFans(ctx, 0, false)];
      // No-honors bonus if the remaining set/pair carries it and no honors overall
      let honors = false;
      for (let i = 27; i < 34; i++) if (counts[i] > 0) honors = true;
      if (!honors) out.push(fan(8));
      return resolve(out);
    }
  }
  return null;
}
const PERMS3 = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
function scoreHand(concealedTiles, melds, ctx) {
  melds = melds || [];
  ctx = ctx || {};
  const meldCount = melds.length;
  const winIdx = ctx.winningTile != null ? KIND_INDEX[ctx.winningTile] : -1;
  const counts = toCounts(concealedTiles);
  const meldGroups = melds.map(meldToGroup);

  // Kong bookkeeping for the kong bonus fans (a kong still scores as its pung
  // set via meldGroups; these are the extra kong-specific points).
  const meldedKongs = melds.filter((m) => m.type === 'kong' && !m.concealed).length;
  const concealedKongs = melds.filter((m) => m.type === 'kong' && m.concealed).length;
  ctx = Object.assign({}, ctx, { meldedKongs, concealedKongs });

  let best = { total: 0, fans: [] };
  const consider = (res) => { if (res && res.total > best.total) best = res; };

  // Special shapes (no melds only)
  if (meldCount === 0) {
    consider(scoreThirteenOrphans(counts, ctx));
    consider(scoreSevenShiftedPairs(counts, ctx));
    consider(scoreSevenPairs(counts, ctx));
    consider(scoreNineGates(counts, ctx, winIdx));
    consider(scoreHonorsKnitted(counts, ctx));
    consider(scoreKnittedStraight(counts, ctx));
  }

  // Standard 4-sets-and-pair decompositions.
  const needSets = 4 - meldCount;
  for (const dec of fullDecomps(counts, needSets)) {
    const concealedSets = dec.sets.map((s) => ({ ...s, concealed: true }));
    const allSets = meldGroups.concat(concealedSets);
    consider(scoreStandard(allSets, dec.pairIdx, ctx, meldCount, winIdx));
  }

  return best;
}

module.exports = { scoreHand, KIND_INDEX };

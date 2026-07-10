'use strict';

// Game engine for simplified Hong Kong-style mahjong.
// See PLAN.md for the binding protocol / rules spec.

const bot = require('./bot');
const { scoreHand } = require('./score');

const SEAT_WINDS = ['wE', 'wS', 'wW', 'wN'];

// ---------------------------------------------------------------------------
// Tile kinds and canonical sort order
// ---------------------------------------------------------------------------
// Sort order: suit m, p, s, then winds (E,S,W,N), then dragons (R,G,W),
// rank ascending within each suit.
const KINDS = [];
for (const s of ['m', 'p', 's']) for (let r = 1; r <= 9; r++) KINDS.push(s + r);
for (const w of ['E', 'S', 'W', 'N']) KINDS.push('w' + w);
for (const d of ['R', 'G', 'W']) KINDS.push('d' + d);
// KINDS.length === 34

const KIND_INDEX = Object.create(null);
KINDS.forEach((k, i) => { KIND_INDEX[k] = i; });

// Flower / season bonus tiles — ONE physical copy each (8 total). These live
// outside the 34-kind standard model: they are never held in hand, never
// discarded, never melded, and never scored by the (flower-agnostic) scorer.
const FLOWER_KINDS = ['f1', 'f2', 'f3', 'f4', 'g1', 'g2', 'g3', 'g4'];
function isFlower(kind) {
  return typeof kind === 'string' && (kind[0] === 'f' || kind[0] === 'g');
}

function parseKind(kind) {
  const suit = kind[0];
  if (suit === 'm' || suit === 'p' || suit === 's') {
    return { suit, rank: parseInt(kind.slice(1), 10), suited: true };
  }
  return { suit, honor: kind.slice(1), suited: false };
}

function sortTiles(tiles) {
  return tiles.slice().sort((a, b) => {
    const d = KIND_INDEX[a.kind] - KIND_INDEX[b.kind];
    return d !== 0 ? d : a.id - b.id;
  });
}

// ---------------------------------------------------------------------------
// Win detection (recursive decomposition on sorted counts)
// ---------------------------------------------------------------------------
function handCounts(tiles) {
  const c = new Array(34).fill(0);
  for (const t of tiles) c[KIND_INDEX[t.kind]]++;
  return c;
}

// A kind index is a valid run start only inside a numeric suit block with two
// higher neighbours in the same suit (ranks 1..7 → index offsets 0..6).
function isRunStart(i) {
  return (i >= 0 && i <= 6) || (i >= 9 && i <= 15) || (i >= 18 && i <= 24);
}

// Can the remaining counts be fully partitioned into triplets and runs?
function formsSets(counts) {
  let i = 0;
  while (i < 34 && counts[i] === 0) i++;
  if (i === 34) return true;
  // Triplet
  if (counts[i] >= 3) {
    counts[i] -= 3;
    if (formsSets(counts)) { counts[i] += 3; return true; }
    counts[i] += 3;
  }
  // Run
  if (isRunStart(i) && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i]--; counts[i + 1]--; counts[i + 2]--;
    const ok = formsSets(counts);
    counts[i]++; counts[i + 1]++; counts[i + 2]++;
    if (ok) return true;
  }
  return false;
}

function isSevenPairs(counts) {
  let pairs = 0;
  for (const c of counts) {
    if (c === 0) continue;
    if (c === 2) pairs++;
    else return false;
  }
  return pairs === 7;
}

// tiles = concealed tiles only (14 - 3*meldCount of them). meldCount melds are
// already-complete sets so we only need (4 - meldCount) sets + 1 pair here.
function isWinningHand(tiles, meldCount) {
  const counts = handCounts(tiles);
  if (meldCount === 0 && isSevenPairs(counts)) return true;
  for (let i = 0; i < 34; i++) {
    if (counts[i] >= 2) {
      counts[i] -= 2;
      const ok = formsSets(counts);
      counts[i] += 2;
      if (ok) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Game class
// ---------------------------------------------------------------------------
// The dead wall is a fixed-size stack kept at the BACK of the deck. Flower and
// kong replacements are taken from its top; after each such draw it is
// backfilled from the tail of the live wall so it stays constant (until the
// live wall is exhausted). Normal turn draws come only from the live wall.
const DEAD_WALL_SIZE = 4;

class Game {
  // opts: { roomId, roomName, seats:[{name,isBot,connected,playerId}], onChange,
  //         dealerSeat, roundWind, match }
  constructor(opts) {
    this.roomId = opts.roomId;
    this.roomName = opts.roomName;
    this.seats = opts.seats.map((s) => ({
      name: s.name,
      isBot: !!s.isBot,
      connected: s.connected !== false,
      playerId: s.playerId || null,
    }));
    this.onChange = opts.onChange || (() => {});

    // Match context: which seat deals this hand and the prevalent (round) wind.
    // Defaults keep single-hand behaviour (seat 0 = East dealer, East round).
    this.dealerSeat = ((opts.dealerSeat || 0) % 4 + 4) % 4;
    this.roundWind = opts.roundWind || 'wE';
    this.match = opts.match || null; // optional Match orchestrator (for state injection)

    this.wall = [];         // live wall — normal turn draws pop from its FRONT (end of array)
    this.deadWall = [];     // fixed-size back stack — flower/kong replacements come off its top
    this.wallBackTaken = 0; // total tiles taken from the dead wall (flower + kong replacements)
    this.hands = [[], [], [], []];
    this.melds = [[], [], [], []];
    this.discards = [[], [], [], []];
    this.flowers = [[], [], [], []]; // exposed bonus tiles per seat (public)

    this.turn = 0;
    this.turnPhase = 'discard'; // "discard" | "claims"
    this.drawnTile = null;
    this.tsumoAvailable = false;
    this.replacementDraw = false; // the current drawnTile came from a kong replacement (→ Out with Replacement Tile)
    this.lastDiscard = null;
    this.claimWindow = null; // { discardSeat, tile, options:{seat:[..]}, responses:{}, kongRob? }
    this.pendingKong = null; // added-kong awaiting a robbing-the-kong window resolution
    this.claimTimer = null;

    this.phase = 'playing'; // "playing" | "finished"
    this.winner = null;

    this.timers = new Set();
    this.destroyed = false;
  }

  // --- timer management (guarded against game end / teardown) ---------------
  setTimer(fn, ms) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (this.destroyed || this.phase !== 'playing') return;
      try { fn(); } catch (e) { /* never crash on a timer */ }
    }, ms);
    this.timers.add(id);
    return id;
  }

  clearTimers() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.claimTimer = null;
  }

  destroy() {
    this.destroyed = true;
    this.phase = 'finished';
    this.clearTimers();
  }

  emit() {
    if (this.destroyed) return;
    this.onChange(this);
  }

  // Seat wind for `seat`, relative to the current dealer (dealer = East).
  seatWindOf(seat) {
    return SEAT_WINDS[(seat - this.dealerSeat + 4) % 4];
  }

  // --- MCR scoring helpers --------------------------------------------------
  // Build the win-context for the scorer. `winTile` is a tile object.
  buildCtx(seat, winTile, selfDrawn, extra) {
    extra = extra || {};
    return {
      selfDrawn,
      seatWind: this.seatWindOf(seat),
      roundWind: this.roundWind,
      fullyConcealed: this.melds[seat].length === 0 && selfDrawn,
      lastWallTile: this.wall.length === 0,
      winningTile: winTile ? winTile.kind : null,
      isDealer: seat === this.dealerSeat,
      // v5 kong context: winning on a kong replacement (Out with Replacement
      // Tile) or off a tile added to a melded pung (Robbing the Kong).
      replacementWin: !!extra.replacement,
      robbingKong: !!extra.robbingKong,
    };
  }

  // Score a completed hand for `seat` won on `winTile`. Assumes hands[seat] holds
  // the concealed tiles EXCLUDING the winning tile (as in beginTurn / claim / win).
  scoreWin(seat, winTile, selfDrawn, extra) {
    const concealed = this.hands[seat].map((t) => t.kind);
    if (winTile) concealed.push(winTile.kind);
    const melds = this.melds[seat].map((m) => ({
      type: m.type, tiles: m.tiles.map((t) => t.kind), concealed: !!m.concealed,
    }));
    return scoreHand(concealed, melds, this.buildCtx(seat, winTile, selfDrawn, extra));
  }

  // Any complete winning shape wins — first to mahjong, regardless of score.
  // (The scorer still runs to produce the winner's fan breakdown; a 0-point win
  // is legal.) `winTile`/`selfDrawn` are accepted for call-site symmetry.
  canWin(seat, winTile, selfDrawn) { // eslint-disable-line no-unused-vars
    const concealed = this.hands[seat].concat(winTile ? [winTile] : []);
    return isWinningHand(concealed, this.melds[seat].length);
  }

  // --- flower resolution ----------------------------------------------------
  // Pop tiles from the wall for `seat`, exposing any flowers into flowers[seat]
  // (in draw order) and continuing until a non-flower is found. Returns that
  // non-flower tile, or null if the wall empties while resolving (→ draw game).
  // Take one replacement tile off the TOP of the dead wall, backfilling the dead
  // wall from the TAIL of the live wall so it stays a constant size (until the
  // live wall is exhausted). Falls back to the live wall's tail if the dead wall
  // is somehow empty. Tracks the count. Returns the tile, or null if nothing is
  // left anywhere.
  drawBack() {
    let tile = null;
    if (this.deadWall.length > 0) {
      tile = this.deadWall.pop();
      // Keep the dead wall constant: pull one tile from the tail of the live wall.
      if (this.wall.length > 0) this.deadWall.unshift(this.wall.shift());
    } else if (this.wall.length > 0) {
      tile = this.wall.shift(); // no dead wall left — draw from the live tail
    } else {
      return null;
    }
    this.wallBackTaken++;
    return tile;
  }

  // Draw a normal turn tile from the FRONT of the live wall for `seat`,
  // auto-exposing any flowers and taking their replacements from the dead wall
  // until a non-flower arrives. Returns that non-flower tile, or null if
  // everything empties while resolving (→ draw game).
  drawForSeat(seat) {
    let t = this.wall.length > 0 ? this.wall.pop() : null;
    while (t !== null && isFlower(t.kind)) {
      this.flowers[seat].push(t);
      t = this.drawBack();
    }
    return t;
  }

  // Draw a kong/flower REPLACEMENT tile for `seat` from the dead wall, exposing
  // any flowers along the way. Returns the non-flower replacement, or null if
  // the deck empties (→ draw game).
  drawReplacement(seat) {
    let t = this.drawBack();
    while (t !== null && isFlower(t.kind)) {
      this.flowers[seat].push(t);
      t = this.drawBack();
    }
    return t;
  }

  // After the initial deal, move any dealt flowers out of `seat`'s hand into its
  // flowers array and draw non-flower replacements until the hand holds 13 again.
  // Returns false if the wall exhausted during replacement (caller → draw game).
  resolveDealtFlowers(seat) {
    for (let i = this.hands[seat].length - 1; i >= 0; i--) {
      if (isFlower(this.hands[seat][i].kind)) {
        this.flowers[seat].push(this.hands[seat][i]);
        this.hands[seat].splice(i, 1);
      }
    }
    // Replacements for dealt flowers come from the BACK of the wall (same end as
    // in-play flower replacements), exposing any flowers drawn along the way.
    while (this.hands[seat].length < 13) {
      const t = this.drawBack();
      if (t === null) return false;
      if (isFlower(t.kind)) { this.flowers[seat].push(t); continue; }
      this.hands[seat].push(t);
    }
    return true;
  }

  // --- setup ----------------------------------------------------------------
  start() {
    // Build 144-tile wall: 4 of each of the 34 standard kinds + 8 flowers.
    const wall = [];
    let id = 0;
    for (const kind of KINDS) {
      for (let c = 0; c < 4; c++) wall.push({ id: id++, kind });
    }
    for (const kind of FLOWER_KINDS) wall.push({ id: id++, kind }); // one each
    // Fisher-Yates shuffle.
    for (let i = wall.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = wall[i]; wall[i] = wall[j]; wall[j] = tmp;
    }
    // Set aside a fixed-size dead wall from the tail end of the live wall (the
    // opposite end from where normal turn draws pop). The full 144-tile wall is
    // fully accounted for: live wall + dead wall + dealt hands = 144.
    this.deadWall = wall.splice(0, DEAD_WALL_SIZE);
    this.wall = wall;
    // Deal 13 each (may include flowers, resolved below).
    for (let s = 0; s < 4; s++) {
      for (let n = 0; n < 13; n++) this.hands[s].push(this.wall.pop());
    }
    // Resolve all dealt flowers in seat order (dealer first) BEFORE play begins.
    for (let s = 0; s < 4; s++) {
      if (!this.resolveDealtFlowers(s)) { this.endDraw(); return; }
    }
    // Dealer begins with a draw.
    this.beginTurn(this.dealerSeat);
  }

  // --- turn flow ------------------------------------------------------------
  beginTurn(seat) {
    if (this.phase !== 'playing') return;
    if (this.wall.length === 0) { this.endDraw(); return; }
    this.turn = seat;
    this.turnPhase = 'discard';
    this.lastDiscard = null;
    this.claimWindow = null;
    this.pendingKong = null;
    this.replacementDraw = false;
    if (this.claimTimer) { clearTimeout(this.claimTimer); this.claimTimer = null; }

    // Draw a tile, auto-exposing any flowers and taking replacements. If the
    // wall empties while resolving flowers, the round ends in a draw.
    const tile = this.drawForSeat(seat);
    if (tile === null) { this.endDraw(); return; }
    this.drawnTile = tile;
    // Tsumo is offered whenever the drawn tile completes a valid winning shape.
    this.tsumoAvailable = this.canWin(seat, tile, true);

    this.emit();
    if (this.seats[seat].isBot) bot.takeBotTurn(this, seat);
  }

  discard(seat, tileId) {
    if (this.phase !== 'playing') throw new Error('game is not active');
    if (this.turn !== seat) throw new Error('not your turn');
    if (this.turnPhase !== 'discard') throw new Error('not in discard phase');
    if (typeof tileId !== 'number') throw new Error('invalid tileId');

    let tile;
    if (this.drawnTile && this.drawnTile.id === tileId) {
      tile = this.drawnTile;
      this.drawnTile = null;
    } else {
      const idx = this.hands[seat].findIndex((t) => t.id === tileId);
      if (idx === -1) throw new Error('tile not in hand');
      tile = this.hands[seat][idx];
      this.hands[seat].splice(idx, 1);
      if (this.drawnTile) { this.hands[seat].push(this.drawnTile); this.drawnTile = null; }
    }

    this.tsumoAvailable = false;
    this.replacementDraw = false;
    this.discards[seat].push(tile);
    this.lastDiscard = { seat, tile };
    this.openClaimWindow(seat, tile);
  }

  // --- claims ---------------------------------------------------------------
  // The distinct runs `seat` could form with the current claim tile (for the UI to
  // let the player pick when a discard completes a run more than one way). [] unless
  // it's this seat's chi option in the open claim window.
  chiOptionsFor(seat) {
    if (this.turnPhase !== 'claims' || !this.claimWindow) return [];
    const opts = this.claimWindow.options[seat];
    if (!opts || !opts.includes('chi')) return [];
    return this.chiShapes(seat, this.claimWindow.tile).map((sh) => ({
      tiles: sh.tiles.map((t) => ({ id: t.id, kind: t.kind })),
    }));
  }

  chiShapes(seat, tile) {
    const p = parseKind(tile.kind);
    if (!p.suited) return [];
    const suit = p.suit;
    const rank = p.rank;
    const hand = this.hands[seat];
    const findRank = (r) => hand.find((t) => {
      const q = parseKind(t.kind);
      return q.suited && q.suit === suit && q.rank === r;
    });
    // Runs containing `rank`, ordered by lowest starting rank first.
    const pairs = [[rank - 2, rank - 1], [rank - 1, rank + 1], [rank + 1, rank + 2]];
    const shapes = [];
    for (const [a, b] of pairs) {
      if (a < 1 || a > 9 || b < 1 || b > 9) continue;
      const ta = findRank(a);
      const tb = findRank(b);
      if (ta && tb && ta.id !== tb.id) shapes.push({ tiles: [ta, tb] });
    }
    return shapes;
  }

  openClaimWindow(discardSeat, tile) {
    const options = {};
    for (let s = 0; s < 4; s++) {
      if (s === discardSeat) continue;
      const opts = [];
      // Ron — whenever the discard completes a valid winning shape.
      if (this.canWin(s, tile, false)) opts.push('ron');
      // Pon (hold 2) and melded Kong from a discard (hold 3).
      const matching = this.hands[s].filter((t) => t.kind === tile.kind).length;
      if (matching >= 2) opts.push('pon');
      if (matching >= 3) opts.push('kong');
      // Chi — only the player to the discarder's left.
      if (s === (discardSeat + 1) % 4 && this.chiShapes(s, tile).length > 0) opts.push('chi');

      if (opts.length > 0) { opts.push('pass'); options[s] = opts; }
    }

    const eligible = Object.keys(options).map(Number);
    if (eligible.length === 0) {
      this.lastDiscard = null;
      this.beginTurn((discardSeat + 1) % 4);
      return;
    }

    this.turnPhase = 'claims';
    this.claimWindow = { discardSeat, tile, options, responses: {}, chiChoice: {} };
    this.emit();

    // No claim timer (v5): the window stays open until EVERY eligible player has
    // responded. Bots respond instantly (keeps the game from stalling); humans
    // must explicitly claim or pass.
    for (const s of eligible) {
      if (this.seats[s].isBot) bot.handleBotClaim(this, s);
    }
  }

  handleClaim(seat, action, chiTiles) {
    if (this.phase !== 'playing') throw new Error('game is not active');

    if (action === 'tsumo') {
      if (this.turn === seat && this.turnPhase === 'discard' && this.tsumoAvailable) {
        this.declareWin(seat, 'tsumo', this.drawnTile);
        return;
      }
      throw new Error('cannot declare tsumo now');
    }

    if (this.turnPhase !== 'claims' || !this.claimWindow) throw new Error('no claim pending');
    const opts = this.claimWindow.options[seat];
    if (!opts) throw new Error('not eligible to claim');
    if (!opts.includes(action)) throw new Error('invalid claim action');
    if (this.claimWindow.responses[seat]) return; // already responded

    // Chi with a specific run choice: record which two hand tiles to use (when the
    // discard completes a run more than one way). Ignored if it doesn't match a
    // valid shape — doChi then falls back to the lowest run.
    if (action === 'chi' && Array.isArray(chiTiles) && chiTiles.length === 2) {
      const shapes = this.chiShapes(seat, this.claimWindow.tile);
      const ok = shapes.some((sh) => {
        const ids = sh.tiles.map((t) => t.id);
        return ids.includes(chiTiles[0]) && ids.includes(chiTiles[1]);
      });
      if (ok) this.claimWindow.chiChoice[seat] = [chiTiles[0], chiTiles[1]];
    }

    this.claimWindow.responses[seat] = action;
    const eligible = Object.keys(this.claimWindow.options).map(Number);
    const allResponded = eligible.every((s) => this.claimWindow.responses[s]);
    if (allResponded) this.resolveClaims();
    else this.emit();
  }

  resolveClaims() {
    if (!this.claimWindow) return;
    const cw = this.claimWindow;
    if (this.claimTimer) { clearTimeout(this.claimTimer); this.claimTimer = null; }
    const resp = cw.responses;
    const order = [1, 2, 3].map((o) => (cw.discardSeat + o) % 4);

    // Robbing-the-kong window: only ron is offered on the added-kong tile.
    if (cw.kongRob) {
      let robber = null;
      for (const s of order) if (resp[s] === 'ron') { robber = s; break; }
      const pk = this.pendingKong;
      this.claimWindow = null;
      this.pendingKong = null;
      this.turnPhase = 'discard';
      if (robber !== null) {
        // Won off the tile being added to a melded pung → Robbing the Kong.
        this.declareWin(robber, 'ron', cw.tile, cw.discardSeat, { robbingKong: true });
        return;
      }
      if (pk) this.finalizeAddedKong(pk.seat, pk.tile, pk.meldIndex);
      return;
    }

    // Priority ron > (kong = pung) > chi. Among equal priority, closest seat
    // after the discarder in turn order wins. Kong and pung tie: whichever a
    // seat responded with, taken in seat order.
    let chosen = null;
    for (const s of order) if (resp[s] === 'ron') { chosen = { seat: s, action: 'ron' }; break; }
    if (!chosen) for (const s of order) {
      if (resp[s] === 'kong') { chosen = { seat: s, action: 'kong' }; break; }
      if (resp[s] === 'pon') { chosen = { seat: s, action: 'pon' }; break; }
    }
    if (!chosen) for (const s of order) if (resp[s] === 'chi') { chosen = { seat: s, action: 'chi' }; break; }

    this.claimWindow = null;
    this.turnPhase = 'discard';

    if (!chosen) {
      this.lastDiscard = null;
      this.beginTurn((cw.discardSeat + 1) % 4);
      return;
    }

    if (chosen.action === 'ron') {
      this.removeDiscardTile(cw.discardSeat, cw.tile);
      this.declareWin(chosen.seat, 'ron', cw.tile, cw.discardSeat);
      return;
    }

    // kong / pon / chi — the claimed tile moves out of the discard pile into a meld.
    this.removeDiscardTile(cw.discardSeat, cw.tile);
    if (chosen.action === 'kong') this.doKong(chosen.seat, cw.tile);
    else if (chosen.action === 'pon') this.doPon(chosen.seat, cw.tile);
    else this.doChi(chosen.seat, cw.tile, cw.chiChoice && cw.chiChoice[chosen.seat]);
  }

  removeDiscardTile(seat, tile) {
    const d = this.discards[seat];
    const i = d.findIndex((t) => t.id === tile.id);
    if (i !== -1) d.splice(i, 1);
  }

  doPon(seat, tile) {
    const matches = this.hands[seat].filter((t) => t.kind === tile.kind).slice(0, 2);
    for (const m of matches) {
      const i = this.hands[seat].findIndex((t) => t.id === m.id);
      this.hands[seat].splice(i, 1);
    }
    this.melds[seat].push({ type: 'pon', tiles: sortTiles([matches[0], matches[1], tile]) });
    this.claimerToDiscard(seat);
  }

  doChi(seat, tile, chosenIds) {
    const shapes = this.chiShapes(seat, tile);
    let shape = shapes[0]; // default: lowest run
    if (chosenIds && chosenIds.length === 2) {
      const match = shapes.find((sh) => {
        const ids = sh.tiles.map((t) => t.id);
        return ids.includes(chosenIds[0]) && ids.includes(chosenIds[1]);
      });
      if (match) shape = match;
    }
    for (const m of shape.tiles) {
      const i = this.hands[seat].findIndex((t) => t.id === m.id);
      this.hands[seat].splice(i, 1);
    }
    this.melds[seat].push({ type: 'chi', tiles: sortTiles([shape.tiles[0], shape.tiles[1], tile]) });
    this.claimerToDiscard(seat);
  }

  claimerToDiscard(seat) {
    this.turn = seat;
    this.turnPhase = 'discard';
    this.drawnTile = null;
    this.tsumoAvailable = false;
    this.replacementDraw = false;
    this.lastDiscard = null;
    this.emit();
    if (this.seats[seat].isBot) bot.takeBotTurn(this, seat);
  }

  // --- kongs ----------------------------------------------------------------
  // Melded kong claimed from a discard: the claimer holds 3 matching tiles and
  // takes the discard as the 4th. Draw a replacement, then they must discard.
  doKong(seat, tile) {
    const matches = this.hands[seat].filter((t) => t.kind === tile.kind).slice(0, 3);
    for (const m of matches) {
      const i = this.hands[seat].findIndex((t) => t.id === m.id);
      this.hands[seat].splice(i, 1);
    }
    this.melds[seat].push({ type: 'kong', concealed: false, tiles: sortTiles(matches.concat([tile])) });
    this.drawKongReplacement(seat, true);
  }

  // Common tail for any kong: give `seat` the turn, pull a replacement tile from
  // the dead wall (exposing flowers), and let them continue (discard / another
  // kong / win). If the deck empties during the replacement, the hand is a draw.
  drawKongReplacement(seat) {
    this.turn = seat;
    this.turnPhase = 'discard';
    this.lastDiscard = null;
    this.claimWindow = null;
    const rep = this.drawReplacement(seat);
    if (rep === null) { this.endDraw(); return; }
    this.drawnTile = rep;
    this.replacementDraw = true; // winning on this tile scores Out with Replacement Tile
    this.tsumoAvailable = this.canWin(seat, rep, true);
    this.emit();
    if (this.seats[seat].isBot) bot.takeBotTurn(this, seat);
  }

  // Self-declared kong on your own turn (after your draw): concealed (4 in hand)
  // or added (promote your exposed pung with its 4th tile).
  declareKong(seat, kind) {
    if (this.phase !== 'playing') throw new Error('game is not active');
    if (this.turn !== seat) throw new Error('not your turn');
    if (this.turnPhase !== 'discard') throw new Error('not in discard phase');
    if (typeof kind !== 'string') throw new Error('invalid kind');
    if (isFlower(kind)) throw new Error('cannot kong a flower');

    const pool = this.hands[seat].slice();
    if (this.drawnTile) pool.push(this.drawnTile);
    const countOf = pool.filter((t) => t.kind === kind).length;

    // Added kong: an exposed pung of `kind` + you hold the 4th tile.
    const pungIdx = this.melds[seat].findIndex((m) => m.type === 'pon' && m.tiles[0].kind === kind);
    if (pungIdx !== -1 && countOf >= 1) { this.doAddedKong(seat, kind, pungIdx); return; }
    // Concealed kong: you hold all 4.
    if (countOf === 4) { this.doConcealedKong(seat, kind); return; }
    throw new Error('cannot declare kong for ' + kind);
  }

  // Pull the tiles of `kind` out of hand + drawnTile, folding any leftover drawn
  // tile back into the hand (its slot is reused for the replacement draw).
  takeKindFromConcealed(seat, kind, n) {
    const taken = [];
    if (this.drawnTile && this.drawnTile.kind === kind) { taken.push(this.drawnTile); this.drawnTile = null; }
    for (let i = this.hands[seat].length - 1; i >= 0 && taken.length < n; i--) {
      if (this.hands[seat][i].kind === kind) { taken.push(this.hands[seat][i]); this.hands[seat].splice(i, 1); }
    }
    if (this.drawnTile) { this.hands[seat].push(this.drawnTile); this.drawnTile = null; }
    return taken;
  }

  doConcealedKong(seat, kind) {
    const taken = this.takeKindFromConcealed(seat, kind, 4);
    this.melds[seat].push({ type: 'kong', concealed: true, tiles: sortTiles(taken) });
    this.drawKongReplacement(seat);
  }

  doAddedKong(seat, kind, meldIndex) {
    const taken = this.takeKindFromConcealed(seat, kind, 1);
    const tile = taken[0];
    // Robbing the kong: anyone waiting on this exact tile may ron it. If someone
    // can, open a ron-only window and defer completing the kong until it resolves.
    if (this.openKongRobWindow(seat, kind, tile, meldIndex)) return;
    this.finalizeAddedKong(seat, tile, meldIndex);
  }

  finalizeAddedKong(seat, tile, meldIndex) {
    const meld = this.melds[seat][meldIndex];
    meld.type = 'kong';
    meld.concealed = false;
    meld.tiles = sortTiles(meld.tiles.concat([tile]));
    this.drawKongReplacement(seat);
  }

  // Returns true (and emits a claims window) if any opponent can rob this kong.
  openKongRobWindow(seat, kind, tile, meldIndex) {
    const options = {};
    for (let s = 0; s < 4; s++) {
      if (s === seat) continue;
      if (this.canWin(s, tile, false)) options[s] = ['ron', 'pass'];
    }
    const eligible = Object.keys(options).map(Number);
    if (eligible.length === 0) return false;
    this.pendingKong = { seat, kind, tile, meldIndex };
    this.turnPhase = 'claims';
    this.claimWindow = { discardSeat: seat, tile, options, responses: {}, kongRob: true };
    this.lastDiscard = { seat, tile }; // let clients highlight the robbable tile
    this.emit();
    for (const s of eligible) if (this.seats[s].isBot) bot.handleBotClaim(this, s);
    return true;
  }

  // --- endings --------------------------------------------------------------
  // `fromSeat` = the discarder whose tile was ronned (null/undefined for tsumo).
  declareWin(seat, winType, tile, fromSeat, extra) {
    extra = extra || {};
    this.clearTimers();
    this.phase = 'finished';
    this.turnPhase = 'discard';
    const selfDrawn = winType === 'tsumo';
    const winTile = selfDrawn ? this.drawnTile : tile;
    // Score BEFORE mutating hand — scoreWin reads hands[seat] (excludes winTile).
    // Scoring no longer gates the win (any winning shape wins); it runs purely to
    // report the fan breakdown. The scorer is flower-agnostic, so here we add the
    // "Flower Tiles" fan (+1 each) to the winner's reported score.
    const score = winTile ? this.scoreWin(seat, winTile, selfDrawn, {
      replacement: selfDrawn && this.replacementDraw,
      robbingKong: !!extra.robbingKong,
    }) : null;
    const flowerCount = this.flowers[seat].length;
    if (score && flowerCount > 0) {
      score.fans = score.fans.concat([{ name: 'Flower Tiles', points: flowerCount }]);
      score.total += flowerCount;
    }
    const hand = this.hands[seat].slice();
    if (winTile) hand.push(winTile);
    this.winner = {
      seat,
      name: this.seats[seat].name,
      winType,
      // Discarder seat for a ron (used by the match to bill the right payer).
      discarder: winType === 'ron' && typeof fromSeat === 'number' ? fromSeat : null,
      hand: sortTiles(hand).map((t) => ({ id: t.id, kind: t.kind })),
      melds: this.melds[seat].map((m) => ({ type: m.type, tiles: m.tiles.map((t) => ({ id: t.id, kind: t.kind })) })),
      winningTile: winTile ? { id: winTile.id, kind: winTile.kind } : null,
      score,
    };
    this.drawnTile = null;
    this.lastDiscard = null;
    this.claimWindow = null;
    this.emit();
  }

  endDraw() {
    this.clearTimers();
    this.phase = 'finished';
    this.turnPhase = 'discard';
    this.winner = { seat: null, name: null, winType: 'draw', hand: null, melds: null, score: null };
    this.drawnTile = null;
    this.lastDiscard = null;
    this.claimWindow = null;
    this.emit();
  }

  // --- disconnect handling --------------------------------------------------
  replaceBot(seat) {
    if (this.phase !== 'playing') return;
    const s = this.seats[seat];
    s.isBot = true;
    s.connected = false;
    if (!/\(bot\)/.test(s.name)) s.name = s.name + ' (bot)';
    this.emit();
    if (this.turn === seat && this.turnPhase === 'discard') bot.takeBotTurn(this, seat);
    if (this.turnPhase === 'claims' && this.claimWindow &&
        this.claimWindow.options[seat] && !this.claimWindow.responses[seat]) {
      bot.handleBotClaim(this, seat);
    }
  }

  // Kinds `seat` may concealed-kong or added-kong right now (own turn, after the
  // draw). [] otherwise. Concealed = 4 identical held; added = an exposed pung of
  // the kind plus holding its 4th tile.
  selfKongOptionsFor(seat) {
    if (this.phase !== 'playing') return [];
    if (this.turnPhase !== 'discard' || seat !== this.turn) return [];
    const pool = this.hands[seat].slice();
    if (this.drawnTile) pool.push(this.drawnTile);
    const counts = Object.create(null);
    for (const t of pool) counts[t.kind] = (counts[t.kind] || 0) + 1;
    const opts = new Set();
    for (const k of Object.keys(counts)) if (counts[k] === 4 && !isFlower(k)) opts.add(k);
    for (const m of this.melds[seat]) {
      if (m.type === 'pon') {
        const k = m.tiles[0].kind;
        if ((counts[k] || 0) >= 1) opts.add(k);
      }
    }
    return [...opts];
  }

  // --- state snapshots ------------------------------------------------------
  claimOptionsFor(seat) {
    if (this.phase !== 'playing') return [];
    if (this.turnPhase === 'discard' && seat === this.turn && this.tsumoAvailable) return ['tsumo'];
    if (this.turnPhase === 'claims' && this.claimWindow &&
        this.claimWindow.options[seat] && !this.claimWindow.responses[seat]) {
      return this.claimWindow.options[seat].slice();
    }
    return [];
  }

  getStateFor(seat) {
    const players = this.seats.map((s, i) => ({
      seat: i,
      name: s.name,
      isBot: s.isBot,
      connected: s.connected,
      handCount: this.hands[i].length + (i === this.turn && this.drawnTile ? 1 : 0),
      melds: this.melds[i].map((m) => ({
        type: m.type,
        tiles: m.tiles.map((t) => ({ id: t.id, kind: t.kind })),
      })),
      discards: this.discards[i].map((t) => ({ id: t.id, kind: t.kind })),
      flowers: this.flowers[i].map((t) => ({ id: t.id, kind: t.kind })),
      isDealer: i === this.dealerSeat,
      seatWind: this.seatWindOf(i),
    }));

    const drawnTile = (seat === this.turn && this.drawnTile)
      ? { id: this.drawnTile.id, kind: this.drawnTile.kind } : null;

    const lastDiscard = this.lastDiscard
      ? { seat: this.lastDiscard.seat, tile: { id: this.lastDiscard.tile.id, kind: this.lastDiscard.tile.kind } }
      : null;

    const state = {
      roomId: this.roomId,
      roomName: this.roomName,
      phase: this.phase,
      yourSeat: seat,
      turn: this.turn,
      turnPhase: this.turnPhase,
      wallCount: this.wall.length,
      wallBackTaken: this.wallBackTaken,
      deadWallCount: this.deadWall.length,
      players,
      yourHand: sortTiles(this.hands[seat]).map((t) => ({ id: t.id, kind: t.kind })),
      drawnTile,
      lastDiscard,
      claimOptions: this.claimOptionsFor(seat),
      chiOptions: this.chiOptionsFor(seat),
      selfKongOptions: this.selfKongOptionsFor(seat),
      winner: this.winner,
    };
    // Match orchestration fields (handNumber, balances, streaks, history, ledger).
    if (this.match) {
      state.match = this.match.snapshotState();
      state.matchComplete = !!this.match.matchComplete;
    }
    return state;
  }
}

module.exports = { Game, isWinningHand, isSevenPairs, sortTiles, KINDS, KIND_INDEX, FLOWER_KINDS, isFlower };

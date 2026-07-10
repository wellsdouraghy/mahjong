'use strict';

// Match orchestrator (v4): a 16-hand money match built on top of the single-hand
// `Game` engine. The match owns the persistent per-seat identity (name / bot /
// connection / playerId), the running balances / streaks / ledger / history, and
// the dealer + round-wind rotation. It deals a fresh `Game` per hand, settles the
// money when each hand finishes, then auto-advances to the next hand.
//
// See PLAN.md sections "Match play & money (v4)" and "Scoreboard & settlement (v4)".

const { Game } = require('./game');

const TOTAL_HANDS = 16;
const ROUND_WINDS = ['wE', 'wS', 'wW', 'wN']; // 4 hands each
// Reveal window between hands before auto-dealing the next. Overridable via env
// (default unchanged) so automated tests can advance without a 6s real wait.
const ADVANCE_MS = (() => {
  const v = Number(process.env.MAHJONG_ADVANCE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 6000;
})();
const DOLLARS_PER_POINT = 1;

// Streak -> multiplier: win once/none = 1x, twice in a row = 2x, three+ = 3x.
function multiplierOf(streak) {
  if (streak >= 3) return 3;
  if (streak === 2) return 2;
  return 1;
}

class Match {
  // opts: { roomId, roomName, seats:[{name,isBot,connected,playerId}], onChange }
  constructor(opts) {
    this.roomId = opts.roomId;
    this.roomName = opts.roomName;
    // Persistent seat identity across all 16 hands (index == seat).
    this.seats = opts.seats.map((s) => ({
      name: s.name,
      isBot: !!s.isBot,
      connected: s.connected !== false,
      playerId: s.playerId || null,
    }));
    this.onChange = opts.onChange || (() => {});

    this.totalHands = TOTAL_HANDS;
    this.handNumber = 0;               // becomes 1 on the first deal
    this.currentDealer = 0;            // dealer seat for the hand in progress
    this.currentRoundWind = ROUND_WINDS[0];

    this.balances = [0, 0, 0, 0];      // running net $ per seat (may be negative)
    this.streaks = [0, 0, 0, 0];       // consecutive-win streaks per seat
    this.ledger = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]; // ledger[a][b] = $ a paid b
    this.history = [];                 // one entry per completed hand

    this.game = null;
    this.handSettled = false;          // guard: settle each finished hand once
    this.matchComplete = false;
    this.advanceTimer = null;
    this.destroyed = false;
  }

  // --- lifecycle ------------------------------------------------------------
  start() {
    this.dealHand();
  }

  dealHand() {
    if (this.destroyed) return;
    this.handNumber += 1;
    this.currentDealer = (this.handNumber - 1) % 4;
    this.currentRoundWind = ROUND_WINDS[Math.floor((this.handNumber - 1) / 4)] || 'wN';
    this.handSettled = false;

    const seats = this.seats.map((s) => ({
      name: s.name, isBot: s.isBot, connected: s.connected, playerId: s.playerId,
    }));
    this.game = new Game({
      roomId: this.roomId,
      roomName: this.roomName,
      seats,
      dealerSeat: this.currentDealer,
      roundWind: this.currentRoundWind,
      match: this,
      onChange: (g) => this.handleGameChange(g),
    });
    this.game.start();
    // If start() didn't already terminate (a draw during flower resolution can),
    // emit an initial playing snapshot; handleGameChange covers the rest.
    if (!this.destroyed && !this.handSettled && this.game && this.game.phase === 'playing') {
      // game.start() already emitted via beginTurn -> onChange; nothing more here.
    }
  }

  handleGameChange(game) {
    if (this.destroyed || game !== this.game) return;
    if (game.phase === 'finished' && !this.handSettled) {
      this.settleHand(game);
      this.handSettled = true;
      this.emit();
      this.scheduleAdvance();
      return;
    }
    this.emit();
  }

  emit() {
    if (this.destroyed) return;
    try { this.onChange(this); } catch (e) { /* never crash on broadcast */ }
  }

  scheduleAdvance() {
    if (this.destroyed) return;
    // No auto-advance: after a hand settles the table stays on the finished
    // snapshot until the host clicks "Start Next Game" (-> nextHand()).
    if (this.handNumber >= this.totalHands) {
      this.matchComplete = true;
      this.emit();
    }
  }

  clearAdvanceTimer() {
    if (this.advanceTimer) { clearTimeout(this.advanceTimer); this.advanceTimer = null; }
  }

  // Host-triggered "next hand" (skip the reveal wait). Valid only once a hand has
  // settled and the match is not complete.
  nextHand() {
    if (this.destroyed) return;
    if (!this.handSettled || this.matchComplete) return;
    if (this.handNumber >= this.totalHands) { this.matchComplete = true; this.emit(); return; }
    this.clearAdvanceTimer();
    if (this.game) { this.game.destroy(); }
    this.dealHand();
  }

  // --- settlement -----------------------------------------------------------
  settleHand(game) {
    const w = game.winner;
    if (!w || w.winType === 'draw') {
      // Draw resets every streak; no money changes hands.
      for (let s = 0; s < 4; s++) this.streaks[s] = 0;
      this.history.push({
        handNumber: this.handNumber,
        winnerSeat: null,
        winnerName: null,
        winType: 'draw',
        points: 0,
        fans: [],
        winningHand: [],
        payments: [],
      });
      return;
    }

    const winnerSeat = w.seat;
    const P = (w.score && typeof w.score.total === 'number') ? w.score.total : 0;
    const mWinner = multiplierOf(this.streaks[winnerSeat]);

    // Determine payers: tsumo -> all 3 others; ron -> only the discarder.
    let payers;
    if (w.winType === 'tsumo') {
      payers = [0, 1, 2, 3].filter((s) => s !== winnerSeat);
    } else {
      payers = (typeof w.discarder === 'number') ? [w.discarder] : [];
    }

    const payments = [];
    for (const payer of payers) {
      const rate = Math.max(mWinner, multiplierOf(this.streaks[payer]));
      const amount = P * rate * DOLLARS_PER_POINT;
      payments.push({ from: payer, to: winnerSeat, amount });
      this.balances[payer] -= amount;
      this.balances[winnerSeat] += amount;
      this.ledger[payer][winnerSeat] += amount;
    }

    // Streak update AFTER payments (multipliers were read pre-update).
    for (let s = 0; s < 4; s++) this.streaks[s] = (s === winnerSeat) ? this.streaks[s] + 1 : 0;

    // Attach settlement to the winner object so the finished snapshot carries it.
    w.settlement = { points: P, winnerMultiplier: mWinner, payments: payments.slice() };

    // Full revealed hand = concealed tiles + all meld tiles.
    const winningHand = (w.hand ? w.hand.slice() : []);
    if (w.melds) for (const m of w.melds) for (const t of m.tiles) winningHand.push({ id: t.id, kind: t.kind });

    this.history.push({
      handNumber: this.handNumber,
      winnerSeat,
      winnerName: w.name,
      winType: w.winType,
      points: P,
      fans: (w.score && w.score.fans) ? w.score.fans.map((f) => ({ name: f.name, points: f.points })) : [],
      winningHand,
      payments: payments.slice(),
    });
  }

  // --- seat / player management ---------------------------------------------
  seatOfPlayer(playerId) {
    for (let s = 0; s < 4; s++) if (this.seats[s].playerId === playerId) return s;
    return -1;
  }

  hasHumans() {
    return this.seats.some((s) => s.playerId && !s.isBot);
  }

  // A human left/disconnected mid-match: replace with a bot for the rest of the
  // match (both in the persistent seat and in the live game, if any).
  playerLeft(seat) {
    if (seat < 0 || seat > 3) return;
    const s = this.seats[seat];
    if (!s.isBot && !/\(bot\)$/.test(s.name)) s.name = s.name + ' (bot)';
    s.isBot = true;
    s.connected = false;
    s.playerId = null;
    if (this.game && this.game.phase === 'playing') {
      this.game.replaceBot(seat);
    } else {
      this.emit();
    }
  }

  // --- state ----------------------------------------------------------------
  snapshotState() {
    return {
      handNumber: this.handNumber,
      totalHands: this.totalHands,
      roundWind: this.currentRoundWind,
      dealerSeat: this.currentDealer,
      matchComplete: this.matchComplete,
      players: this.seats.map((s, i) => ({
        seat: i,
        balance: this.balances[i],
        streak: this.streaks[i],
        multiplier: multiplierOf(this.streaks[i]),
      })),
      history: this.history,
      ledger: this.ledger.map((row) => row.slice()),
    };
  }

  destroy() {
    this.destroyed = true;
    this.clearAdvanceTimer();
    if (this.game) { this.game.destroy(); this.game = null; }
  }
}

module.exports = { Match, multiplierOf, TOTAL_HANDS, ROUND_WINDS };

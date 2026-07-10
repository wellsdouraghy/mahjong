'use strict';

// Bot decision logic. Timers are created through game.setTimer so the game can
// clear them on end / teardown (guarded against a finished game).

// Delays are overridable via env (defaults unchanged) so automated tests can run
// full matches quickly. Read at call time so the env can be set before boot.
// "MANDIE MODE" (match.slowBots) makes the bots deliberate noticeably slower.
const SLOW_MULT = 3;
function slowFactor(game) {
  return (game && game.match && game.match.slowBots) ? SLOW_MULT : 1;
}
function botTurnDelay(game) {
  const v = Number(process.env.MAHJONG_BOT_TURN_MS);
  const base = Number.isFinite(v) && v >= 0 ? v : 800;
  return base * slowFactor(game);
}
function botClaimDelay(game) {
  const v = Number(process.env.MAHJONG_BOT_CLAIM_MS);
  const base = Number.isFinite(v) && v >= 0 ? v : 60;
  return base * slowFactor(game);
}

function parseKind(kind) {
  const suit = kind[0];
  if (suit === 'm' || suit === 'p' || suit === 's') {
    return { suit, rank: parseInt(kind.slice(1), 10), suited: true };
  }
  return { suit, honor: kind.slice(1), suited: false };
}

// Higher score = more eager to discard. Prefer isolated honors, then isolated
// terminals/edges, keeping connected suited tiles.
function discardScore(tile, allTiles) {
  const p = parseKind(tile.kind);
  const sameKind = allTiles.filter((t) => t.kind === tile.kind).length;

  if (!p.suited) {
    // Honor tile: a lone honor is the classic safe discard.
    return sameKind >= 2 ? 5 : 100;
  }

  // Suited tile: measure connectivity within its suit.
  let neighbours = 0;
  for (const t of allTiles) {
    if (t.id === tile.id) continue;
    const q = parseKind(t.kind);
    if (!q.suited || q.suit !== p.suit) continue;
    const d = Math.abs(q.rank - p.rank);
    if (d === 0) neighbours += 3;      // pair/triplet material
    else if (d === 1) neighbours += 3; // adjacent
    else if (d === 2) neighbours += 1; // one-gap
  }
  if (neighbours === 0) {
    // Isolated suited tile — terminals a touch more discardable.
    return (p.rank === 1 || p.rank === 9) ? 80 : 70;
  }
  // Connected tile: keep. Lower score for more connectivity.
  return Math.max(1, 40 - neighbours * 5);
}

function chooseDiscard(game, seat) {
  const tiles = game.hands[seat].concat(game.drawnTile ? [game.drawnTile] : []);
  if (tiles.length === 0) return null;
  let best = tiles[0];
  let bestScore = -Infinity;
  for (const t of tiles) {
    const s = discardScore(t, tiles) + Math.random() * 0.5; // random tiebreak
    if (s > bestScore) { bestScore = s; best = t; }
  }
  return best.id;
}

// Called when it becomes a bot's turn (discard phase).
function takeBotTurn(game, seat) {
  game.setTimer(() => {
    if (game.phase !== 'playing' || game.turn !== seat || game.turnPhase !== 'discard') return;
    if (!game.seats[seat] || !game.seats[seat].isBot) return;
    try {
      const opts = game.claimOptionsFor(seat);
      if (opts.includes('tsumo')) { game.handleClaim(seat, 'tsumo'); return; }
      const tileId = chooseDiscard(game, seat);
      if (tileId != null) game.discard(seat, tileId);
    } catch (e) { /* never crash on bot action */ }
  }, botTurnDelay(game));
}

// Called when a claim window opens and this bot is eligible.
// Bot kong policy (v5): bots keep it simple and NEVER stall the game. They take a
// ron if available, otherwise pass on everything — including pon/chi/kong (and
// robbing-the-kong ron windows, where ron is still taken). Bots also never
// declare a self-kong on their own turn (takeBotTurn just discards), so a bot can
// never block the flow waiting on a kong decision.
function handleBotClaim(game, seat) {
  game.setTimer(() => {
    if (game.phase !== 'playing' || game.turnPhase !== 'claims' || !game.claimWindow) return;
    if (!game.seats[seat] || !game.seats[seat].isBot) return;
    try {
      const opts = game.claimOptionsFor(seat);
      if (!opts || opts.length === 0) return;
      if (opts.includes('ron')) game.handleClaim(seat, 'ron');
      else game.handleClaim(seat, 'pass');
    } catch (e) { /* never crash on bot action */ }
  }, botClaimDelay(game));
}

module.exports = { takeBotTurn, handleBotClaim, chooseDiscard };

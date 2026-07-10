'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Match } = require('./match');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const THREE_PATH = path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400); res.end('Bad request'); return;
  }

  if (urlPath.startsWith('/vendor/')) {
    const threeBuildDir = path.dirname(THREE_PATH);
    const vendorFile = path.join(threeBuildDir, path.normalize(urlPath.slice('/vendor/'.length)));
    if (!vendorFile.startsWith(threeBuildDir)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    serveFile(vendorFile, res);
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  serveFile(filePath, res);
});

// ---------------------------------------------------------------------------
// Lobby / room state
// ---------------------------------------------------------------------------
// clients: ws -> { id, name, ws, roomId }
const clients = new Map();
// rooms: roomId -> {
//   id, name, hostId,
//   seats: [ slot|null x4 ],   // slot: {kind:'human', playerId} | {kind:'bot', name}
//   status: 'waiting'|'playing',
//   match: Match|null,
// }
const rooms = new Map();

function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return name.length >= 1 ? name : null;
}

// Short human join codes: unambiguous uppercase letters + digits (no 0/O/1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function roomByCode(code) {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  for (const room of rooms.values()) if (room.code === c) return room;
  return null;
}
function generateRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!roomByCode(code)) return code;
  }
  // Extremely unlikely fallback: extend length until unique.
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }
}

function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

function clientById(id) {
  for (const c of clients.values()) if (c.id === id) return c;
  return null;
}

function nameOf(id) {
  const c = clientById(id);
  return c ? c.name : '(unknown)';
}

// A hand is actively in progress (accepting discard/claim actions).
function roomInActiveGame(room) {
  return !!(room && room.status === 'playing' && room.match &&
    room.match.game && room.match.game.phase === 'playing');
}

// --- seat helpers ----------------------------------------------------------
function firstEmptySeat(room) {
  for (let i = 0; i < 4; i++) if (!room.seats[i]) return i;
  return -1;
}

function roomHumanIds(room) {
  return room.seats.filter((s) => s && s.kind === 'human').map((s) => s.playerId);
}

// Player ids that are still connected humans (source of truth differs mid-match,
// where the Match holds live seat identity after bot replacements).
function connectedHumanIds(room) {
  if (room.status === 'playing' && room.match) {
    return room.match.seats.filter((s) => s.playerId && !s.isBot).map((s) => s.playerId);
  }
  return roomHumanIds(room);
}

function reassignHost(room) {
  const humans = connectedHumanIds(room);
  if (humans.length && !humans.includes(room.hostId)) room.hostId = humans[0];
}

function seatOfHuman(room, playerId) {
  for (let i = 0; i < 4; i++) {
    const s = room.seats[i];
    if (s && s.kind === 'human' && s.playerId === playerId) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Lobby broadcast
// ---------------------------------------------------------------------------
function roomSeatSummary(room) {
  return room.seats.map((slot, i) => {
    if (slot && slot.kind === 'human') return { index: i, kind: 'human', name: nameOf(slot.playerId) };
    if (slot && slot.kind === 'bot') return { index: i, kind: 'bot', name: slot.name };
    return { index: i, kind: 'empty', name: null };
  });
}

function roomSummaries() {
  const list = [];
  for (const room of rooms.values()) {
    list.push({
      id: room.id,
      name: room.name,
      code: room.code,
      hostName: nameOf(room.hostId),
      playerNames: roomHumanIds(room).map(nameOf),
      seats: roomSeatSummary(room),
      status: room.status,
    });
  }
  return list;
}

function broadcastLobby() {
  const rms = roomSummaries();
  for (const client of clients.values()) {
    const room = client.roomId ? rooms.get(client.roomId) : null;
    // Clients currently inside a running match receive gameState, not lobby
    // (this spans the whole match, including between-hand reveals and match-over).
    if (room && room.status === 'playing') continue;
    send(client.ws, {
      type: 'lobby',
      rooms: rms,
      you: {
        playerId: client.id,
        name: client.name,
        roomId: client.roomId || null,
        roomCode: room ? room.code : null,
        isHost: !!(room && room.hostId === client.id),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Game wiring
// ---------------------------------------------------------------------------
function broadcastGameStates(room) {
  if (!room.match || !room.match.game) return;
  const match = room.match;
  for (let seat = 0; seat < 4; seat++) {
    const s = match.seats[seat];
    if (!s || !s.playerId || s.isBot) continue; // bot / vacated seat
    const client = clientById(s.playerId);
    if (!client) continue;
    send(client.ws, { type: 'gameState', state: match.game.getStateFor(seat) });
  }
}

function onMatchChange(room, match) {
  if (room.match !== match) return;
  broadcastGameStates(room);
}

// Start a fresh 16-hand match from the currently-filled seats. All 4 seats must
// be occupied (humans and/or bots); caller enforces that.
function startMatch(room) {
  const seats = room.seats.map((slot) => {
    if (slot && slot.kind === 'human') {
      return { name: nameOf(slot.playerId), isBot: false, connected: true, playerId: slot.playerId };
    }
    if (slot && slot.kind === 'bot') {
      return { name: slot.name, isBot: true, connected: false, playerId: null };
    }
    return { name: 'Bot', isBot: true, connected: false, playerId: null }; // defensive
  });
  if (room.match) { room.match.destroy(); room.match = null; }
  room.status = 'playing';
  const match = new Match({
    roomId: room.id,
    roomName: room.name,
    seats,
    slowBots: !!room.slowBots,   // "MANDIE MODE" persists across matches in a room
    onChange: (m) => onMatchChange(room, m),
  });
  room.match = match;
  match.start();
}

// ---------------------------------------------------------------------------
// Room helpers
// ---------------------------------------------------------------------------
// Detach a client from its room (explicit leave OR disconnect). Handles both the
// lobby (waiting) case and the mid-match case (bot-replace for the rest of the
// match). Does NOT broadcast — caller decides.
function detachFromRoom(client) {
  const room = client.roomId ? rooms.get(client.roomId) : null;
  client.roomId = null;
  if (!room) return;

  if (room.status === 'playing' && room.match) {
    // Mid-match leave: replace the human with a bot for the rest of the match.
    const seat = room.match.seatOfPlayer(client.id);
    if (seat !== -1) {
      room.match.playerLeft(seat);
      // Mirror the bot into the lobby seat model for lobby display / future resets.
      room.seats[seat] = { kind: 'bot', name: room.match.seats[seat].name };
    }
    reassignHost(room);
    if (!room.match.hasHumans()) {
      room.match.destroy();
      room.match = null;
      rooms.delete(room.id);
    }
    return;
  }

  // Waiting-room leave: free the seat.
  const seat = seatOfHuman(room, client.id);
  if (seat !== -1) room.seats[seat] = null;
  if (roomHumanIds(room).length === 0) {
    if (room.match) { room.match.destroy(); room.match = null; }
    rooms.delete(room.id);
  } else if (room.hostId === client.id) {
    reassignHost(room);
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
function handleMessage(client, msg) {
  const type = msg && msg.type;

  if (type === 'hello') {
    const name = sanitizeName(msg.name);
    if (!name) { sendError(client.ws, 'name must be 1-20 characters'); return; }
    client.name = name;
    client.saidHello = true;
    send(client.ws, { type: 'welcome', playerId: client.id });
    broadcastLobby();
    return;
  }

  if (!client.saidHello) { sendError(client.ws, 'send hello first'); return; }

  switch (type) {
    case 'createRoom': {
      if (client.roomId) { sendError(client.ws, 'already in a room'); return; }
      const roomName = sanitizeName(msg.roomName) || `${client.name}'s room`;
      const id = crypto.randomUUID();
      const room = {
        id,
        name: roomName,
        code: generateRoomCode(),
        hostId: client.id,
        seats: [{ kind: 'human', playerId: client.id }, null, null, null],
        status: 'waiting',
        match: null,
      };
      rooms.set(id, room);
      client.roomId = id;
      broadcastLobby();
      break;
    }

    case 'joinRoom': {
      if (client.roomId) { sendError(client.ws, 'already in a room'); return; }
      const room = rooms.get(msg.roomId);
      if (!room) { sendError(client.ws, 'room not found'); return; }
      if (room.status !== 'waiting') { sendError(client.ws, 'game already started'); return; }
      const seat = firstEmptySeat(room);
      if (seat === -1) { sendError(client.ws, 'room is full'); return; }
      room.seats[seat] = { kind: 'human', playerId: client.id };
      client.roomId = room.id;
      broadcastLobby();
      break;
    }

    case 'joinByCode': {
      if (client.roomId) { sendError(client.ws, 'already in a room'); return; }
      const room = roomByCode(msg.code);
      if (!room) { sendError(client.ws, 'no room with that code'); return; }
      if (room.status !== 'waiting') { sendError(client.ws, 'game already started'); return; }
      const seat = firstEmptySeat(room);
      if (seat === -1) { sendError(client.ws, 'room is full'); return; }
      room.seats[seat] = { kind: 'human', playerId: client.id };
      client.roomId = room.id;
      broadcastLobby();
      break;
    }

    case 'leaveRoom': {
      detachFromRoom(client);
      broadcastLobby();
      break;
    }

    case 'addBot': {
      const room = client.roomId ? rooms.get(client.roomId) : null;
      if (!room) { sendError(client.ws, 'not in a room'); return; }
      if (room.hostId !== client.id) { sendError(client.ws, 'only the host can add bots'); return; }
      if (room.status !== 'waiting') { sendError(client.ws, 'cannot add bots during a match'); return; }
      const seat = firstEmptySeat(room);
      if (seat !== -1) { // no-op if full
        room.seats[seat] = { kind: 'bot', name: `Bot ${seat + 1}` };
        broadcastLobby();
      }
      break;
    }

    case 'removeBot': {
      const room = client.roomId ? rooms.get(client.roomId) : null;
      if (!room) { sendError(client.ws, 'not in a room'); return; }
      if (room.hostId !== client.id) { sendError(client.ws, 'only the host can remove bots'); return; }
      if (room.status !== 'waiting') { sendError(client.ws, 'cannot remove bots during a match'); return; }
      const seat = msg.seat;
      if (typeof seat === 'number' && seat >= 0 && seat < 4 &&
          room.seats[seat] && room.seats[seat].kind === 'bot') {
        room.seats[seat] = null;
        broadcastLobby();
      }
      break;
    }

    case 'startGame': {
      const room = client.roomId ? rooms.get(client.roomId) : null;
      if (!room) { sendError(client.ws, 'not in a room'); return; }
      if (room.hostId !== client.id) { sendError(client.ws, 'only the host can start'); return; }
      if (room.status === 'playing') {
        // A finished match may be restarted from the game view.
        if (room.match && room.match.matchComplete) {
          startMatch(room);
          broadcastLobby();
        } else {
          sendError(client.ws, 'game already in progress');
        }
        return;
      }
      if (room.seats.some((s) => !s)) {
        sendError(client.ws, 'all four seats must be filled (add bots or wait for players)');
        return;
      }
      startMatch(room);
      // gameState already broadcast to players; refresh lobby for everyone else.
      broadcastLobby();
      break;
    }

    case 'nextHand': {
      const room = client.roomId ? rooms.get(client.roomId) : null;
      if (!room) { sendError(client.ws, 'not in a room'); return; }
      if (room.hostId !== client.id) { sendError(client.ws, 'only the host can advance the hand'); return; }
      if (room.match) room.match.nextHand(); // internally guarded (no-op unless a hand is settled)
      break;
    }

    case 'discard': {
      const room = client.roomId ? rooms.get(client.roomId) : null;
      if (!roomInActiveGame(room)) { sendError(client.ws, 'no active game'); return; }
      const seat = room.match.seatOfPlayer(client.id);
      if (seat === -1) { sendError(client.ws, 'you are not seated'); return; }
      if (typeof msg.tileId !== 'number') { sendError(client.ws, 'tileId must be a number'); return; }
      try {
        room.match.game.discard(seat, msg.tileId);
      } catch (e) {
        sendError(client.ws, e.message);
      }
      break;
    }

    case 'claimAction': {
      const room = client.roomId ? rooms.get(client.roomId) : null;
      if (!roomInActiveGame(room)) { sendError(client.ws, 'no active game'); return; }
      const seat = room.match.seatOfPlayer(client.id);
      if (seat === -1) { sendError(client.ws, 'you are not seated'); return; }
      const valid = ['pon', 'chi', 'kong', 'ron', 'tsumo', 'pass'];
      if (!valid.includes(msg.action)) { sendError(client.ws, 'invalid action'); return; }
      const chiTiles = Array.isArray(msg.chiTiles)
        ? msg.chiTiles.filter((n) => Number.isInteger(n)).slice(0, 2) : undefined;
      try {
        room.match.game.handleClaim(seat, msg.action, chiTiles);
      } catch (e) {
        sendError(client.ws, e.message);
      }
      break;
    }

    case 'setBotSpeed': {
      // "MANDIE MODE" — any seated player can slow the bots down for the room.
      const room = client.roomId ? rooms.get(client.roomId) : null;
      if (!room) { sendError(client.ws, 'not in a room'); return; }
      room.slowBots = !!msg.slow;
      if (room.match) room.match.setSlowBots(room.slowBots);
      break;
    }

    case 'declareKong': {
      const room = client.roomId ? rooms.get(client.roomId) : null;
      if (!roomInActiveGame(room)) { sendError(client.ws, 'no active game'); return; }
      const seat = room.match.seatOfPlayer(client.id);
      if (seat === -1) { sendError(client.ws, 'you are not seated'); return; }
      if (typeof msg.kind !== 'string') { sendError(client.ws, 'kind must be a string'); return; }
      try {
        room.match.game.declareKong(seat, msg.kind);
      } catch (e) {
        sendError(client.ws, e.message);
      }
      break;
    }

    default:
      sendError(client.ws, `unknown message type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

const DEBUG = !!process.env.MAHJONG_DEBUG;

// Periodic stale-room sweep: delete any room with zero connected humans. Rooms
// are normally freed the instant their last human leaves/disconnects (see
// detachFromRoom + the ws 'close' handler); this is a backstop so no room can
// stay "trapped" if a seat is somehow orphaned. Unref'd so it never keeps the
// process (or a test harness) alive.
const SWEEP_MS = (() => {
  const v = Number(process.env.MAHJONG_SWEEP_MS);
  return Number.isFinite(v) && v > 0 ? v : 30000;
})();
function sweepRooms() {
  let deleted = false;
  for (const room of [...rooms.values()]) {
    if (connectedHumanIds(room).length === 0) {
      if (room.match) { room.match.destroy(); room.match = null; }
      rooms.delete(room.id);
      deleted = true;
    }
  }
  if (deleted) broadcastLobby();
}
const sweepTimer = setInterval(sweepRooms, SWEEP_MS);
if (sweepTimer.unref) sweepTimer.unref();

wss.on('connection', (ws) => {
  const client = { id: crypto.randomUUID(), name: 'Player', ws, roomId: null, saidHello: false };
  clients.set(ws, client);
  if (DEBUG) console.log(`[ws] connect ${client.id.slice(0, 8)} (total ${clients.size})`);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      sendError(ws, 'malformed JSON');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      sendError(ws, 'message must be an object with a string "type"');
      return;
    }
    if (DEBUG) console.log(`[ws] ${client.id.slice(0, 8)} ${client.name} -> ${JSON.stringify(msg).slice(0, 120)}`);
    try {
      handleMessage(client, msg);
    } catch (e) {
      if (DEBUG) console.log(`[ws] handler error: ${e.stack}`);
      sendError(ws, 'server error handling message');
    }
  });

  ws.on('close', () => {
    if (DEBUG) console.log(`[ws] close ${client.id.slice(0, 8)} ${client.name} (total ${clients.size - 1})`);
    clients.delete(ws);
    detachFromRoom(client);
    broadcastLobby();
  });

  ws.on('error', () => { /* ignore socket errors */ });
});

server.listen(PORT, () => {
  console.log(`Mahjong server listening on http://localhost:${PORT} (ws path /ws)`);
});

module.exports = { server };

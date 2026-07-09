// main.js — WebSocket client, message dispatch, state store, send helpers.
import * as lobby from "./lobby.js";
import * as scene from "./scene.js";
import * as hud from "./hud.js";
import * as scoreboard from "./scoreboard.js";

const RECONNECT_MS = 2000;

const state = {
  ws: null,
  connected: false,
  playerId: null,
  you: null,          // {playerId, name, roomId, isHost}
  rooms: [],          // last lobby rooms
  game: null,         // last gameState.state
  pendingName: null,  // name to (re)send hello with after (re)connect
  inGame: false,      // phase "playing" -> game shown
};

// ---- Public accessors used by other modules ----
export function getState() { return state; }
export function getGame() { return state.game; }
export function getYou() { return state.you; }

// ---- Send helpers ----
function rawSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

export function sendHello(name) {
  state.pendingName = name;
  rawSend({ type: "hello", name });
}
export function createRoom(roomName) { rawSend({ type: "createRoom", roomName }); }
export function joinRoom(roomId) { rawSend({ type: "joinRoom", roomId }); }
export function joinByCode(code) { rawSend({ type: "joinByCode", code: String(code || "").trim().toUpperCase() }); }
export function leaveRoom() { rawSend({ type: "leaveRoom" }); }
export function startGame() { rawSend({ type: "startGame" }); }
export function discard(tileId) { rawSend({ type: "discard", tileId }); }
export function claimAction(action) { rawSend({ type: "claimAction", action }); }
// v5: declare a kong on your turn (concealed or added — server determines & validates).
export function declareKong(kind) { rawSend({ type: "declareKong", kind }); }

// v4 match / lobby-bot helpers
export function addBot() { rawSend({ type: "addBot" }); }
export function removeBot(seat) { rawSend({ type: "removeBot", seat }); }
export function nextHand() { rawSend({ type: "nextHand" }); }
export function startNewMatch() { rawSend({ type: "startNewMatch" }); }

// Leave from inside a game: tell the server, then drop back to the lobby view.
export function leaveGame() {
  leaveRoom();
  exitGameView();
}

// ---- Connection status UI ----
function setConn(online) {
  state.connected = online;
  const el = document.getElementById("conn-status");
  if (!el) return;
  el.classList.toggle("online", online);
  el.classList.toggle("offline", !online);
  el.textContent = online ? "Connected" : "Reconnecting…";
}

// ---- Toast (errors) ----
export function toast(message) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---- WebSocket lifecycle ----
function connect() {
  // Use wss:// when the page itself is served over HTTPS (required by hosts like
  // Render / Cloudflare tunnels); plain ws:// for local http.
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.addEventListener("open", () => {
    setConn(true);
    // Re-identify after a reconnect if we already had a name.
    if (state.pendingName) {
      rawSend({ type: "hello", name: state.pendingName });
    }
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    dispatch(msg);
  });

  ws.addEventListener("close", () => {
    setConn(false);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // close will fire after error; keep quiet.
    try { ws.close(); } catch {}
  });
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

// ---- Message dispatch ----
function dispatch(msg) {
  switch (msg.type) {
    case "welcome":
      state.playerId = msg.playerId;
      lobby.onWelcome(msg);
      break;

    case "lobby":
      state.rooms = msg.rooms || [];
      state.you = msg.you || null;
      lobby.onLobby(msg);
      // If a lobby update arrives while we're still in the game view but the
      // server no longer has us in an active room, drop back to the lobby.
      if (state.inGame) {
        const you = state.you;
        const room = you && you.roomId ? state.rooms.find((r) => r.id === you.roomId) : null;
        if (!room || room.status !== "playing") exitGameView();
      }
      break;

    case "gameState":
      onGameState(msg.state);
      break;

    case "error":
      toast(msg.message || "Something went wrong");
      break;

    default:
      // Unknown message type — ignore gracefully.
      break;
  }
}

function onGameState(gs) {
  if (!gs) return;
  state.game = gs;

  if (gs.phase === "playing") {
    // Enter game view.
    if (!state.inGame) {
      state.inGame = true;
      lobby.hide();
      showGame(true);
    }
    scene.update(gs);
    hud.update(gs);
    scoreboard.update(gs);
  } else if (gs.phase === "finished") {
    // Keep the 3D world visible, freeze input, show winner / settlement.
    state.inGame = true; // still in game view until user backs out
    scene.update(gs);
    hud.update(gs);
    scoreboard.update(gs);
  }
}

function showGame(show) {
  document.getElementById("hud").classList.toggle("hidden", !show);
  scene.setVisible(show);
}

// Called by hud "Back to room": leave game view, show room panel again.
export function backToRoom() {
  state.inGame = false;
  state.game = null;
  showGame(false);
  hud.reset();
  scoreboard.reset();
  scene.clearScene();
  lobby.show();
  lobby.showRoomPanel();
}

// Exit the game view and return to the lobby, letting the lobby pick the
// appropriate screen (rooms list vs room panel) from the latest state.
export function exitGameView() {
  if (!state.inGame) return;
  state.inGame = false;
  state.game = null;
  showGame(false);
  hud.reset();
  scoreboard.reset();
  scene.clearScene();
  lobby.show();
  lobby.refresh();
}

// ---- Bootstrap ----
function init() {
  lobby.init();
  hud.init();
  scoreboard.init();
  scene.init(document.getElementById("scene-container"));
  setConn(false);
  connect();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

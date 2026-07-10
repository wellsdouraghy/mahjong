// lobby.js — name entry, room list, create/join/start, in-room panel.
import * as main from "./main.js";

let els = {};
let lastLobby = null;   // last {rooms, you}
let hasName = false;
// An invite link (…?join=CODE) auto-joins that room right after you pick a name.
let pendingJoinCode = (() => {
  try {
    const u = new URL(window.location.href);
    const c = (u.searchParams.get("join") || "").trim().toUpperCase();
    if (c) { history.replaceState(null, "", u.pathname); return c; }
  } catch (e) {}
  return null;
})();

export function init() {
  els = {
    lobby: document.getElementById("lobby"),
    nameScreen: document.getElementById("name-screen"),
    roomsScreen: document.getElementById("rooms-screen"),
    roomScreen: document.getElementById("room-screen"),

    nameForm: document.getElementById("name-form"),
    nameInput: document.getElementById("name-input"),

    youLine: document.getElementById("you-line"),
    roomNameInput: document.getElementById("room-name-input"),
    createRoomBtn: document.getElementById("create-room-btn"),
    joinCodeInput: document.getElementById("join-code-input"),
    joinCodeBtn: document.getElementById("join-code-btn"),
    roomList: document.getElementById("room-list"),
    noRooms: document.getElementById("no-rooms"),

    roomTitle: document.getElementById("room-title"),
    roomStatusBadge: document.getElementById("room-status-badge"),
    roomCodeBox: document.getElementById("room-code-box"),
    roomCodeValue: document.getElementById("room-code-value"),
    copyCodeBtn: document.getElementById("copy-code-btn"),
    roomPlayers: document.getElementById("room-players"),
    startGameBtn: document.getElementById("start-game-btn"),
    leaveRoomBtn: document.getElementById("leave-room-btn"),
    hostNote: document.getElementById("host-note"),
  };

  els.nameForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = els.nameInput.value.trim();
    if (!name) return;
    hasName = true;
    main.sendHello(name);
    // Came in via an invite link → join that room automatically (no typing a code).
    if (pendingJoinCode) {
      main.joinByCode(pendingJoinCode);
      pendingJoinCode = null;
    }
    // Optimistically move to rooms screen; lobby message will populate it.
    showScreen("rooms");
  });

  els.createRoomBtn.addEventListener("click", () => {
    const rn = els.roomNameInput.value.trim() || `${els.nameInput.value.trim() || "New"}'s room`;
    main.createRoom(rn);
    els.roomNameInput.value = "";
  });
  els.roomNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.createRoomBtn.click();
  });

  // Join by code
  const doJoinByCode = () => {
    const code = els.joinCodeInput.value.trim();
    if (!code) return;
    main.joinByCode(code);
    els.joinCodeInput.value = "";
  };
  if (els.joinCodeBtn) els.joinCodeBtn.addEventListener("click", doJoinByCode);
  if (els.joinCodeInput) {
    els.joinCodeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doJoinByCode();
    });
    els.joinCodeInput.addEventListener("input", () => {
      els.joinCodeInput.value = els.joinCodeInput.value.toUpperCase();
    });
  }

  if (els.copyCodeBtn) {
    els.copyCodeBtn.addEventListener("click", () => {
      const code = els.roomCodeValue ? els.roomCodeValue.textContent : "";
      if (!code || code === "—") return;
      // A shareable invite link — friends who open it join the room automatically.
      const link = `${location.origin}${location.pathname}?join=${encodeURIComponent(code)}`;
      const done = () => {
        els.copyCodeBtn.textContent = "Link copied!";
        setTimeout(() => { els.copyCodeBtn.textContent = "Copy link"; }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(done).catch(done);
      } else {
        done();
      }
    });
  }

  els.startGameBtn.addEventListener("click", () => main.startGame());
  els.leaveRoomBtn.addEventListener("click", () => main.leaveRoom());
}

export function onWelcome(_msg) {
  // Nothing extra needed; welcome just confirms identity.
}

export function onLobby(msg) {
  lastLobby = msg;
  render();
}

function render() {
  if (!lastLobby) return;
  const { rooms = [], you } = lastLobby;

  // "you" line
  if (you) {
    els.youLine.textContent = `Signed in as ${you.name}`;
  }

  const inRoom = you && you.roomId;
  const myRoom = inRoom ? rooms.find((r) => r.id === you.roomId) : null;

  if (inRoom && myRoom) {
    renderRoomPanel(myRoom, you);
    // Only auto-switch to room panel if we're not already viewing the game.
    if (!isHidden(els.lobby)) showScreen("room");
  } else {
    renderRoomList(rooms, you);
    if (hasName && !isHidden(els.lobby)) showScreen("rooms");
  }
}

function renderRoomList(rooms, you) {
  els.roomList.innerHTML = "";
  if (!rooms.length) {
    els.noRooms.classList.remove("hidden");
  } else {
    els.noRooms.classList.add("hidden");
  }
  for (const room of rooms) {
    const row = document.createElement("div");
    row.className = "room-row";

    const info = document.createElement("div");
    info.className = "room-info";
    const players = room.playerNames || [];
    info.innerHTML =
      `<div class="r-name">${esc(room.name)}</div>` +
      `<div class="r-meta">Host <span class="r-host">${esc(room.hostName || "—")}</span> · ` +
      `${players.length}/4 players · ${esc(room.status)}</div>`;

    const right = document.createElement("div");
    right.className = "room-right";
    const joinable = room.status === "waiting" && players.length < 4;
    const btn = document.createElement("button");
    btn.className = "btn btn-primary btn-sm";
    btn.textContent = room.status === "waiting" ? "Join" : "In game";
    btn.disabled = !joinable;
    btn.addEventListener("click", () => main.joinRoom(room.id));
    right.appendChild(btn);

    row.appendChild(info);
    row.appendChild(right);
    els.roomList.appendChild(row);
  }
}

// Build a 4-seat array from the room. Prefer the v4 `seats` field; fall back
// to deriving from `playerNames` for an older server.
function seatsOf(room) {
  if (Array.isArray(room.seats) && room.seats.length) {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const s = room.seats.find((x) => x.index === i) || room.seats[i];
      if (s) out.push({ index: i, kind: s.kind || "empty", name: s.name || "" });
      else out.push({ index: i, kind: "empty", name: "" });
    }
    return out;
  }
  // Fallback: humans fill seats in order, rest empty (old server, no bots).
  const names = room.playerNames || [];
  const out = [];
  for (let i = 0; i < 4; i++) {
    if (i < names.length) out.push({ index: i, kind: "human", name: names[i] });
    else out.push({ index: i, kind: "empty", name: "" });
  }
  return out;
}

const SEAT_WINDS = ["East", "South", "West", "North"];

function renderRoomPanel(room, you) {
  els.roomTitle.textContent = room.name;
  els.roomStatusBadge.textContent = room.status;
  els.roomStatusBadge.className = "badge" + (room.status === "playing" ? " playing" : "");

  // Room join code (v5) — show it so the host can share it.
  const code = room.code || (you && you.roomCode) || "";
  if (els.roomCodeBox) {
    if (code) {
      if (els.roomCodeValue) els.roomCodeValue.textContent = code;
      els.roomCodeBox.classList.remove("hidden");
    } else {
      els.roomCodeBox.classList.add("hidden");
    }
  }

  const isHost = !!you.isHost;
  const seats = seatsOf(room);

  els.roomPlayers.innerHTML = "";
  seats.forEach((seat) => {
    const li = document.createElement("li");
    li.className = "seat-row seat-" + seat.kind;

    const dot = document.createElement("span");
    dot.className = "seat-dot";
    dot.textContent = "ESWN"[seat.index] || (seat.index + 1);
    dot.title = SEAT_WINDS[seat.index] || "";
    li.appendChild(dot);

    const name = document.createElement("span");
    name.className = "p-name";
    if (seat.kind === "human") {
      name.textContent = seat.name || `Player ${seat.index + 1}`;
    } else if (seat.kind === "bot") {
      name.innerHTML = `<span class="bot-glyph">🤖</span> ${esc(seat.name || "Bot")}`;
    } else {
      name.textContent = "Empty seat";
      name.classList.add("seat-empty-label");
    }
    li.appendChild(name);

    if (seat.kind === "human" && seat.name === room.hostName) {
      const tag = document.createElement("span");
      tag.className = "p-tag";
      tag.textContent = "HOST";
      li.appendChild(tag);
    } else if (seat.kind === "bot") {
      const tag = document.createElement("span");
      tag.className = "p-tag bot-tag";
      tag.textContent = "BOT";
      li.appendChild(tag);
    }

    // Host-only per-seat control.
    if (isHost && seat.kind === "bot") {
      const rm = document.createElement("button");
      rm.className = "btn btn-ghost btn-xs seat-action";
      rm.textContent = "Remove";
      rm.addEventListener("click", () => main.removeBot(seat.index));
      li.appendChild(rm);
    } else if (isHost && seat.kind === "empty") {
      const add = document.createElement("button");
      add.className = "btn btn-primary btn-xs seat-action";
      add.textContent = "+ Add Bot";
      add.addEventListener("click", () => main.addBot());
      li.appendChild(add);
    }

    els.roomPlayers.appendChild(li);
  });

  const filled = seats.filter((s) => s.kind !== "empty").length;
  const allFull = filled === 4;

  els.startGameBtn.classList.toggle("hidden", !isHost);
  els.startGameBtn.disabled = !allFull;

  if (isHost) {
    els.hostNote.textContent = allFull
      ? "All seats filled — ready to start!"
      : `Add bots or wait for players — ${filled}/4 seats filled.`;
  } else {
    els.hostNote.textContent = "Waiting for the host to start the game…";
  }
}

// ---- Screen switching (within the lobby overlay) ----
function showScreen(which) {
  els.nameScreen.classList.toggle("hidden", which !== "name");
  els.roomsScreen.classList.toggle("hidden", which !== "rooms");
  els.roomScreen.classList.toggle("hidden", which !== "room");
}

export function hide() {
  els.lobby.classList.add("hidden");
}
export function show() {
  els.lobby.classList.remove("hidden");
}

// Re-render from the latest lobby state and let render() pick the right screen.
export function refresh() {
  if (lastLobby) render();
}

// Called when returning from a finished game — show the in-room waiting panel.
export function showRoomPanel() {
  // Re-render from last lobby so the room panel reflects current state.
  if (lastLobby) render();
  showScreen("room");
}

function isHidden(el) { return el.classList.contains("hidden"); }

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

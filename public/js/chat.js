// chat.js — self-contained room chat. Injects its own DOM + <style>; no edits
// to index.html / style.css. Exposes init(), handleMessage(msg), setRoom(inRoom).
import * as main from "./main.js";

let els = {};              // { root, toggle, badge, panel, list, input, send }
let inRoom = false;        // is the player currently in a room?
let open = false;          // is the chat panel open?
let unread = 0;            // unread count while panel closed
let mounted = false;
const MAX_MESSAGES = 200;  // cap DOM growth

const STYLE = `
#chat-root {
  --chat-panel: rgba(20, 26, 40, 0.96);
  --chat-border: rgba(150, 180, 255, 0.18);
  --chat-border-strong: rgba(150, 180, 255, 0.34);
  --chat-text: #eef2fb;
  --chat-dim: #a7b2cc;
  --chat-purple: #a78bfa;
  --chat-blue: #4ea8ff;
  --chat-green: #34e08e;
  --chat-green-deep: #0f7a4a;
  font-family: "Segoe UI", "Helvetica Neue", system-ui, -apple-system, sans-serif;
}
#chat-root, #chat-root * { box-sizing: border-box; }

/* Toggle button — bottom-center, clear of Leave (bottom-left) & Scoreboard (bottom-right). */
#chat-toggle {
  position: fixed;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 90;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  border: 1px solid var(--chat-border-strong);
  background: linear-gradient(150deg, #2a2050, #17203a);
  color: var(--chat-text);
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
  display: none;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.5);
  transition: transform 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
}
#chat-toggle:hover { transform: translateX(-50%) translateY(-3px) scale(1.05); box-shadow: 0 14px 30px rgba(0,0,0,0.55); }
#chat-toggle:active { transform: translateX(-50%) scale(0.96); }
#chat-root.in-room #chat-toggle { display: flex; }
#chat-root.open #chat-toggle { background: linear-gradient(150deg, #3a2c66, #1c2748); }

#chat-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 10px;
  background: linear-gradient(140deg, #ff77c8, #7c5cf0);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 20px;
  text-align: center;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  display: none;
}
#chat-badge.show { display: block; }

/* Slide-in panel — right side above the toggle. */
#chat-panel {
  position: fixed;
  right: 16px;
  bottom: 84px;
  z-index: 91;
  width: 330px;
  max-width: calc(100vw - 32px);
  height: 60vh;
  max-height: 480px;
  background: var(--chat-panel);
  border: 1px solid var(--chat-border);
  border-radius: 18px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(10px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transform: translateY(14px) scale(0.98);
  transform-origin: bottom right;
  transition: opacity 0.18s ease, transform 0.18s ease;
}
#chat-root.open #chat-panel { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); }

#chat-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--chat-border);
  background: linear-gradient(120deg, rgba(124,92,240,0.16), rgba(78,168,255,0.10));
}
#chat-header .ch-title { font-weight: 700; font-size: 14px; color: var(--chat-text); letter-spacing: 0.3px; }
#chat-header .ch-sub { font-size: 11px; color: var(--chat-dim); margin-left: auto; }
#chat-close {
  border: none; background: transparent; color: var(--chat-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 4px; border-radius: 8px;
}
#chat-close:hover { color: var(--chat-text); background: rgba(255,255,255,0.08); }

#chat-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
#chat-list::-webkit-scrollbar { width: 8px; }
#chat-list::-webkit-scrollbar-thumb { background: rgba(150,180,255,0.22); border-radius: 8px; }

.chat-empty { margin: auto; color: var(--chat-dim); font-size: 13px; text-align: center; padding: 0 18px; }

.chat-msg { display: flex; flex-direction: column; max-width: 84%; }
.chat-msg .cm-name { font-size: 11px; font-weight: 700; color: var(--chat-blue); margin: 0 0 2px 2px; }
.chat-msg .cm-bubble {
  padding: 7px 11px;
  border-radius: 14px;
  font-size: 13.5px;
  line-height: 1.35;
  color: var(--chat-text);
  background: rgba(78, 168, 255, 0.12);
  border: 1px solid rgba(78, 168, 255, 0.22);
  word-wrap: break-word;
  overflow-wrap: anywhere;
}
/* Your own messages: right-aligned, purple/green accent. */
.chat-msg.mine { align-self: flex-end; align-items: flex-end; }
.chat-msg.mine .cm-name { color: var(--chat-green); margin: 0 2px 2px 0; }
.chat-msg.mine .cm-bubble {
  background: linear-gradient(140deg, rgba(124,92,240,0.30), rgba(15,122,74,0.28));
  border-color: rgba(167,139,250,0.4);
}

#chat-form {
  display: flex;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--chat-border);
  background: rgba(0,0,0,0.14);
}
#chat-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 9px 12px;
  border-radius: 12px;
  border: 1px solid var(--chat-border);
  background: rgba(10, 14, 24, 0.7);
  color: var(--chat-text);
  font-size: 13.5px;
  font-family: inherit;
  outline: none;
}
#chat-input:focus { border-color: var(--chat-border-strong); }
#chat-input::placeholder { color: var(--chat-dim); }
#chat-send {
  flex: 0 0 auto;
  padding: 0 16px;
  border-radius: 12px;
  border: none;
  background: linear-gradient(140deg, #7c5cf0, #2f7de0);
  color: #fff;
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  transition: transform 0.12s ease, filter 0.12s ease;
}
#chat-send:hover { filter: brightness(1.1); transform: translateY(-1px); }
#chat-send:active { transform: translateY(0) scale(0.97); }

@media (max-width: 560px) {
  #chat-panel {
    right: 8px; left: 8px; bottom: 82px;
    width: auto; max-width: none; height: 56vh;
  }
  #chat-toggle { bottom: 14px; }
}
`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function init() {
  if (mounted) return;
  mounted = true;

  const style = document.createElement("style");
  style.id = "chat-style";
  style.textContent = STYLE;
  document.head.appendChild(style);

  const root = el("div");
  root.id = "chat-root";

  // Toggle button
  const toggle = el("button");
  toggle.id = "chat-toggle";
  toggle.title = "Chat";
  toggle.setAttribute("aria-label", "Toggle chat");
  toggle.textContent = "💬";
  const badge = el("span");
  badge.id = "chat-badge";
  toggle.appendChild(badge);

  // Panel
  const panel = el("div");
  panel.id = "chat-panel";

  const header = el("div");
  header.id = "chat-header";
  header.appendChild(el("span", "ch-title", "Room Chat"));
  header.appendChild(el("span", "ch-sub", "Players in your room"));
  const closeBtn = el("button", null, "×");
  closeBtn.id = "chat-close";
  closeBtn.title = "Close";
  header.appendChild(closeBtn);

  const list = el("div");
  list.id = "chat-list";
  const empty = el("div", "chat-empty", "No messages yet. Say hi! 👋");
  list.appendChild(empty);

  const form = el("form");
  form.id = "chat-form";
  const input = el("input");
  input.id = "chat-input";
  input.type = "text";
  input.maxLength = 200;
  input.placeholder = "Type a message…";
  input.autocomplete = "off";
  const send = el("button", null, "Send");
  send.id = "chat-send";
  send.type = "submit";
  form.appendChild(input);
  form.appendChild(send);

  panel.appendChild(header);
  panel.appendChild(list);
  panel.appendChild(form);

  root.appendChild(toggle);
  root.appendChild(panel);
  document.body.appendChild(root);

  els = { root, toggle, badge, panel, list, input, send, empty };

  toggle.addEventListener("click", () => setOpen(!open));
  closeBtn.addEventListener("click", () => setOpen(false));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    doSend();
  });

  applyRoomClass();
}

function doSend() {
  const text = els.input.value.trim();
  if (!text || !inRoom) return;
  main.sendChat(text);
  els.input.value = "";
  els.input.focus();
}

function setOpen(next) {
  open = !!next && inRoom;
  els.root.classList.toggle("open", open);
  if (open) {
    unread = 0;
    updateBadge();
    scrollToBottom();
    setTimeout(() => els.input && els.input.focus(), 60);
  }
}

// Called by main when the player enters/leaves a room.
export function setRoom(next) {
  inRoom = !!next;
  if (!inRoom && open) setOpen(false);
  applyRoomClass();
}

function applyRoomClass() {
  if (!els.root) return;
  els.root.classList.toggle("in-room", inRoom);
}

// Handle an incoming { type:'chat', from, name, text, ts } message.
export function handleMessage(msg) {
  if (!mounted || !msg) return;
  const from = msg.from;
  const name = typeof msg.name === "string" ? msg.name : "";
  const text = typeof msg.text === "string" ? msg.text : "";
  if (!text) return;

  const myId = safeMyId();
  const mine = !!myId && from === myId;
  appendMessage(name, text, mine);

  if (!open && !mine) {
    unread = Math.min(unread + 1, 99);
    updateBadge();
  }
}

function safeMyId() {
  try {
    const s = main.getState && main.getState();
    return s ? s.playerId : null;
  } catch (e) {
    return null;
  }
}

function appendMessage(name, text, mine) {
  if (els.empty && els.empty.parentNode) els.empty.remove();

  const wrap = el("div", "chat-msg" + (mine ? " mine" : ""));
  wrap.appendChild(el("span", "cm-name", mine ? "You" : (name || "Player")));
  wrap.appendChild(el("span", "cm-bubble", text)); // textContent → HTML-safe
  els.list.appendChild(wrap);

  // Cap DOM size.
  while (els.list.childElementCount > MAX_MESSAGES) {
    els.list.removeChild(els.list.firstElementChild);
  }
  scrollToBottom();
}

function scrollToBottom() {
  if (els.list) els.list.scrollTop = els.list.scrollHeight;
}

function updateBadge() {
  if (!els.badge) return;
  if (unread > 0) {
    els.badge.textContent = unread > 99 ? "99+" : String(unread);
    els.badge.classList.add("show");
  } else {
    els.badge.classList.remove("show");
  }
}

// scoreboard.js — scoreboard panel, who-owes-who (raw + smart netting),
// between-hand settlement popup, and match-over overlay.
import * as main from "./main.js";
import { makeChip } from "./hud.js";

let els = {};
let lastGs = null;
let panelOpen = false;
let smartMode = true;      // "Smart payments" toggle default ON
let lastSettlementHand = null;   // hand number we already popped a settlement for

const WIND_LABEL = { wE: "East", wS: "South", wW: "West", wN: "North" };
const WIN_TYPE_LABEL = { tsumo: "Tsumo", ron: "Ron", draw: "Draw" };

export function init() {
  els = {
    panel: document.getElementById("scoreboard-panel"),
    popup: document.getElementById("settlement-popup"),
    matchOver: document.getElementById("match-over"),
    scoreboardBtn: document.getElementById("scoreboard-btn"),
  };
}

export function toggle() {
  panelOpen = !panelOpen;
  if (els.scoreboardBtn) els.scoreboardBtn.classList.toggle("active", panelOpen);
  if (panelOpen) renderPanel();
  els.panel.classList.toggle("hidden", !panelOpen);
  // v5: when open, the panel must sit above the top-right "Connected" pill.
  // The HUD is its own stacking context, so demote the pill via a body class.
  document.body.classList.toggle("scoreboard-open", panelOpen);
}

export function update(gs) {
  lastGs = gs;
  if (!gs) return;

  if (panelOpen) renderPanel();

  const matchOver = isMatchOver(gs);

  if (gs.phase === "finished") {
    if (matchOver) {
      hidePopup();
      renderMatchOver(gs);
    } else if (gs.match) {
      els.matchOver.classList.add("hidden");
      renderSettlementPopup(gs);
    }
  } else {
    // A new hand is dealing / in progress — clear the between-hand UI.
    hidePopup();
    els.matchOver.classList.add("hidden");
  }
}

export function reset() {
  panelOpen = false;
  document.body.classList.remove("scoreboard-open");
  if (els.panel) els.panel.classList.add("hidden");
  if (els.popup) els.popup.classList.add("hidden");
  if (els.matchOver) els.matchOver.classList.add("hidden");
  if (els.scoreboardBtn) els.scoreboardBtn.classList.remove("active");
  lastSettlementHand = null;
  lastGs = null;
}

function isMatchOver(gs) {
  if (!gs || gs.phase !== "finished") return false;
  if (gs.matchComplete) return true;
  if (gs.winner && gs.winner.matchComplete) return true;
  const m = gs.match;
  if (m && m.handNumber != null && m.totalHands != null && m.handNumber >= m.totalHands) return true;
  return false;
}

// ------------------------------------------------------------------ helpers

function nameOf(gs, seat) {
  const p = (gs.players || [])[seat];
  return p && p.name ? p.name : `Seat ${seat + 1}`;
}

function money(v) {
  const n = Math.round(v || 0);
  return n < 0 ? `-$${Math.abs(n)}` : `$${n}`;
}

// Build an itemized fan breakdown block: one row per fan "Name +N", then a total.
function fanBreakdown(fans, total, cls) {
  const box = document.createElement("div");
  box.className = "fan-breakdown " + (cls || "");
  let sum = 0;
  for (const f of fans) {
    const pts = f && typeof f.points === "number" ? f.points : 0;
    sum += pts;
    const row = document.createElement("div");
    row.className = "fb-row";
    const name = document.createElement("span");
    name.className = "fb-name";
    name.textContent = f && f.name ? f.name : "Fan";
    const p = document.createElement("span");
    p.className = "fb-pts";
    p.textContent = `+${pts}`;
    row.appendChild(name);
    row.appendChild(p);
    box.appendChild(row);
  }
  const tot = document.createElement("div");
  tot.className = "fb-row fb-total";
  const tname = document.createElement("span");
  tname.className = "fb-name";
  tname.textContent = "Total";
  const tpts = document.createElement("span");
  tpts.className = "fb-pts";
  const shown = (typeof total === "number") ? total : sum;
  tpts.textContent = `${shown} pt${shown === 1 ? "" : "s"}`;
  tot.appendChild(tname);
  tot.appendChild(tpts);
  box.appendChild(tot);
  return box;
}

// Normalize the 4x4 ledger (ledger[a][b] = total $ a paid b).
function normLedger(match) {
  const L = [];
  const src = (match && Array.isArray(match.ledger)) ? match.ledger : null;
  for (let a = 0; a < 4; a++) {
    L[a] = [];
    for (let b = 0; b < 4; b++) {
      L[a][b] = (src && src[a] && typeof src[a][b] === "number") ? src[a][b] : 0;
    }
  }
  return L;
}

// Raw pairwise net: for each pair, the net direction/amount.
function rawPayments(L) {
  const out = [];
  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) {
      const net = L[a][b] - L[b][a];
      if (net > 0) out.push({ from: a, to: b, amount: net });
      else if (net < 0) out.push({ from: b, to: a, amount: -net });
    }
  }
  return out;
}

// Minimized settlement: net each player (paid-received), then greedily match
// the biggest debtor (owes/pays) to the biggest creditor (receives).
function smartPayments(L) {
  const net = [];   // >0 => this player paid out more than received => they pay
  for (let p = 0; p < 4; p++) {
    let paid = 0, recv = 0;
    for (let b = 0; b < 4; b++) { paid += L[p][b]; recv += L[b][p]; }
    net[p] = paid - recv;
  }
  const debtors = [];   // owe money (pay)
  const creditors = []; // are owed money (receive)
  for (let p = 0; p < 4; p++) {
    if (net[p] > 0.0001) debtors.push({ p, amt: net[p] });
    else if (net[p] < -0.0001) creditors.push({ p, amt: -net[p] });
  }
  debtors.sort((x, y) => y.amt - x.amt);
  creditors.sort((x, y) => y.amt - x.amt);

  const out = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i], c = creditors[j];
    const t = Math.min(d.amt, c.amt);
    if (t > 0.0001) out.push({ from: d.p, to: c.p, amount: Math.round(t) });
    d.amt -= t; c.amt -= t;
    if (d.amt <= 0.0001) i++;
    if (c.amt <= 0.0001) j++;
  }
  return out;
}

// ------------------------------------------------------------------ panel

function renderPanel() {
  const gs = lastGs;
  els.panel.innerHTML = "";
  if (!gs) return;

  const m = gs.match;
  const hand = m && m.handNumber != null ? m.handNumber : (gs.phase === "finished" ? "—" : "1");
  const total = m && m.totalHands != null ? m.totalHands : 16;

  // Header
  const header = document.createElement("div");
  header.className = "sb-header";
  header.innerHTML =
    `<div class="sb-title">Scoreboard</div>` +
    `<div class="sb-sub">Hand ${hand} of ${total}</div>`;
  const close = document.createElement("button");
  close.className = "sb-close";
  close.textContent = "✕";
  close.addEventListener("click", () => toggle());
  header.appendChild(close);
  els.panel.appendChild(header);

  // Balances
  const balWrap = document.createElement("div");
  balWrap.className = "sb-balances";
  const mplayers = (m && m.players) || [];
  for (let seat = 0; seat < 4; seat++) {
    const mp = mplayers.find((p) => p.seat === seat) || mplayers[seat] || {};
    const bal = mp.balance || 0;
    const mult = mp.multiplier || 1;
    const streak = mp.streak || 0;
    const card = document.createElement("div");
    card.className = "sb-bal" + (bal > 0 ? " up" : bal < 0 ? " down" : "") +
      (seat === gs.yourSeat ? " you" : "");
    card.innerHTML =
      `<div class="sb-bal-name">${escHtml(nameOf(gs, seat))}</div>` +
      `<div class="sb-bal-money">${money(bal)}</div>` +
      `<div class="sb-bal-streak">${mult > 1 ? `🔥 ${mult}× streak` : (streak > 0 ? `${streak} win${streak === 1 ? "" : "s"}` : "—")}</div>`;
    balWrap.appendChild(card);
  }
  els.panel.appendChild(balWrap);

  // History
  const histSection = document.createElement("div");
  histSection.className = "sb-section";
  histSection.innerHTML = `<div class="sb-section-title">Hand history</div>`;
  const histList = document.createElement("div");
  histList.className = "sb-history";
  const history = (m && Array.isArray(m.history)) ? m.history : [];
  if (!history.length) {
    const empty = document.createElement("div");
    empty.className = "sb-empty";
    empty.textContent = "No hands played yet.";
    histList.appendChild(empty);
  } else {
    for (const h of history) histList.appendChild(historyRow(gs, h));
  }
  histSection.appendChild(histList);
  els.panel.appendChild(histSection);

  // Who owes who
  const owe = document.createElement("div");
  owe.className = "sb-section";
  const oweHead = document.createElement("div");
  oweHead.className = "sb-owe-head";
  oweHead.innerHTML = `<div class="sb-section-title">Who owes who</div>`;
  const toggleWrap = document.createElement("label");
  toggleWrap.className = "sb-toggle";
  toggleWrap.innerHTML =
    `<input type="checkbox" ${smartMode ? "checked" : ""}/>` +
    `<span class="sb-toggle-track"><span class="sb-toggle-thumb"></span></span>` +
    `<span class="sb-toggle-label">Smart payments</span>`;
  const cb = toggleWrap.querySelector("input");
  cb.addEventListener("change", () => { smartMode = cb.checked; renderPanel(); });
  oweHead.appendChild(toggleWrap);
  owe.appendChild(oweHead);

  const L = normLedger(m);
  const payments = smartMode ? smartPayments(L) : rawPayments(L);
  const list = document.createElement("div");
  list.className = "sb-owe-list";
  if (!payments.length) {
    const empty = document.createElement("div");
    empty.className = "sb-empty";
    empty.textContent = smartMode ? "All settled up — nobody owes anybody." : "No payments yet.";
    list.appendChild(empty);
  } else {
    for (const pay of payments) {
      const row = document.createElement("div");
      row.className = "sb-owe-row";
      row.innerHTML =
        `<span class="owe-from">${escHtml(nameOf(gs, pay.from))}</span>` +
        `<span class="owe-arrow">→</span>` +
        `<span class="owe-to">${escHtml(nameOf(gs, pay.to))}</span>` +
        `<span class="owe-amt">${money(pay.amount)}</span>`;
      list.appendChild(row);
    }
  }
  owe.appendChild(list);
  const hint = document.createElement("div");
  hint.className = "sb-owe-hint";
  hint.textContent = smartMode
    ? "Minimized: fewest transfers that settle every debt."
    : "Raw: net of each pair's payments.";
  owe.appendChild(hint);
  els.panel.appendChild(owe);
}

function historyRow(gs, h) {
  const row = document.createElement("div");
  const draw = h.winType === "draw" || h.winnerSeat == null;
  row.className = "sb-hand" + (draw ? " draw" : "");

  const top = document.createElement("div");
  top.className = "sb-hand-top";
  const winName = draw ? "Draw" : (h.winnerName || nameOf(gs, h.winnerSeat));
  top.innerHTML =
    `<span class="sb-hand-num">#${h.handNumber != null ? h.handNumber : "?"}</span>` +
    `<span class="sb-hand-winner">${escHtml(winName)}</span>` +
    `<span class="sb-hand-type">${WIN_TYPE_LABEL[h.winType] || h.winType || ""}</span>` +
    (draw ? "" : `<span class="sb-hand-pts">${h.points || 0} pt${(h.points === 1) ? "" : "s"}</span>`);
  row.appendChild(top);

  if (!draw && Array.isArray(h.winningHand) && h.winningHand.length) {
    const chips = document.createElement("div");
    chips.className = "sb-hand-chips";
    for (const t of h.winningHand) chips.appendChild(makeChip(t.kind, false));
    row.appendChild(chips);
  }

  // Itemized fan breakdown for this hand.
  if (!draw && Array.isArray(h.fans) && h.fans.length) {
    row.appendChild(fanBreakdown(h.fans, h.points || 0, "sb-hand-fans"));
  }

  const pays = Array.isArray(h.payments) ? h.payments : [];
  if (pays.length) {
    const pd = document.createElement("div");
    pd.className = "sb-hand-pays";
    pd.textContent = pays.map((p) =>
      `${nameOf(gs, p.from)} → ${nameOf(gs, p.to)} ${money(p.amount)}`).join("  ·  ");
    row.appendChild(pd);
  } else if (draw) {
    const pd = document.createElement("div");
    pd.className = "sb-hand-pays muted";
    pd.textContent = "No payment";
    row.appendChild(pd);
  }
  return row;
}

// ------------------------------------------------------------ settlement popup

function renderSettlementPopup(gs) {
  const m = gs.match;
  const handNo = m && m.handNumber != null ? m.handNumber : null;
  // Only pop once per hand.
  if (handNo != null && handNo === lastSettlementHand && !els.popup.classList.contains("hidden")) return;
  lastSettlementHand = handNo;

  const w = gs.winner;
  const draw = !w || w.winType === "draw" || !w.name || w.winnerSeat === null;

  els.popup.innerHTML = "";
  const card = document.createElement("div");
  card.className = "settle-card";

  if (draw) {
    card.classList.add("draw");
    card.innerHTML =
      `<div class="settle-emoji">🤝</div>` +
      `<div class="settle-title">Draw</div>` +
      `<div class="settle-line">No payment this hand.</div>`;
  } else {
    const st = w.settlement || {};
    const points = st.points != null ? st.points : (w.score && w.score.total) || 0;
    const mult = st.winnerMultiplier || 1;
    const payments = Array.isArray(st.payments) ? st.payments : [];
    const winnerSeat = w.seat != null ? w.seat : (payments[0] ? payments[0].to : gs.yourSeat);
    const won = payments.filter((p) => p.to === winnerSeat).reduce((s, p) => s + (p.amount || 0), 0);

    // Confetti burst
    const conf = document.createElement("div");
    conf.className = "confetti";
    for (let i = 0; i < 14; i++) {
      const bit = document.createElement("span");
      bit.style.setProperty("--i", i);
      conf.appendChild(bit);
    }
    card.appendChild(conf);

    const body = document.createElement("div");
    body.className = "settle-body";
    body.innerHTML =
      `<div class="settle-emoji">🎉</div>` +
      `<div class="settle-title">${escHtml(w.name)} wins!</div>` +
      `<div class="settle-line big">${points} point${points === 1 ? "" : "s"} → <b>${money(won)}</b>` +
      (mult > 1 ? ` <span class="settle-mult">🔥 ${mult}× streak!</span>` : "") + `</div>` +
      `<div class="settle-type">${w.winType === "tsumo" ? "Self-draw (tsumo)" : "Off a discard (ron)"}</div>`;
    card.appendChild(body);

    // Itemized fan breakdown — explains how the point total was reached.
    const fans = (w.score && Array.isArray(w.score.fans)) ? w.score.fans : [];
    if (fans.length) {
      card.appendChild(fanBreakdown(fans, points, "settle-fans"));
    }

    if (payments.length) {
      const pd = document.createElement("div");
      pd.className = "settle-pays";
      for (const p of payments) {
        const r = document.createElement("div");
        r.className = "settle-pay-row";
        r.innerHTML =
          `<span>${escHtml(nameOf(gs, p.from))}</span>` +
          `<span class="settle-arrow">pays</span>` +
          `<span>${escHtml(nameOf(gs, p.to))}</span>` +
          `<span class="settle-amt">${money(p.amount)}</span>`;
        pd.appendChild(r);
      }
      card.appendChild(pd);
    }
  }

  const foot = document.createElement("div");
  foot.className = "settle-foot";
  const you = main.getYou && main.getYou();
  const total = m && m.totalHands != null ? m.totalHands : 16;
  const moreHands = handNo != null && handNo < total;
  if (moreHands) {
    // No auto-advance — the host must start the next game.
    if (you && you.isHost) {
      const next = document.createElement("button");
      next.className = "btn btn-primary btn-block";
      next.textContent = "Start Next Game →";
      next.addEventListener("click", () => main.nextHand());
      foot.appendChild(next);
    } else {
      const wait = document.createElement("span");
      wait.className = "settle-next";
      wait.textContent = "Waiting for the host to start the next game…";
      foot.appendChild(wait);
    }
  } else {
    const next = document.createElement("span");
    next.className = "settle-next";
    next.textContent = "Match ending…";
    foot.appendChild(next);
  }
  card.appendChild(foot);

  els.popup.appendChild(card);
  els.popup.classList.remove("hidden");
}

function hidePopup() {
  if (els.popup) els.popup.classList.add("hidden");
}

// --------------------------------------------------------------- match over

function renderMatchOver(gs) {
  const m = gs.match;
  els.matchOver.innerHTML = "";
  const card = document.createElement("div");
  card.className = "match-over-card";

  const conf = document.createElement("div");
  conf.className = "confetti big";
  for (let i = 0; i < 24; i++) {
    const bit = document.createElement("span");
    bit.style.setProperty("--i", i);
    conf.appendChild(bit);
  }
  card.appendChild(conf);

  const mplayers = (m && m.players) || [];
  const standings = [];
  for (let seat = 0; seat < 4; seat++) {
    const mp = mplayers.find((p) => p.seat === seat) || mplayers[seat] || {};
    standings.push({ seat, name: nameOf(gs, seat), balance: mp.balance || 0 });
  }
  standings.sort((a, b) => b.balance - a.balance);

  const head = document.createElement("div");
  head.className = "mo-head";
  head.innerHTML =
    `<div class="mo-crown">👑</div>` +
    `<h2>Match complete!</h2>` +
    `<p class="mo-champ">${escHtml(standings[0].name)} takes the match with ${money(standings[0].balance)}</p>`;
  card.appendChild(head);

  const board = document.createElement("div");
  board.className = "mo-standings";
  standings.forEach((s, rank) => {
    const row = document.createElement("div");
    row.className = "mo-row" + (rank === 0 ? " first" : "") +
      (s.balance > 0 ? " up" : s.balance < 0 ? " down" : "");
    const medal = ["🥇", "🥈", "🥉", "  "][rank] || "  ";
    row.innerHTML =
      `<span class="mo-rank">${medal}</span>` +
      `<span class="mo-name">${escHtml(s.name)}${s.seat === gs.yourSeat ? " (you)" : ""}</span>` +
      `<span class="mo-money">${money(s.balance)}</span>`;
    board.appendChild(row);
  });
  card.appendChild(board);

  const foot = document.createElement("div");
  foot.className = "mo-foot";
  const you = main.getYou && main.getYou();
  if (you && you.isHost) {
    const nm = document.createElement("button");
    nm.className = "btn btn-primary";
    nm.textContent = "New Match";
    nm.addEventListener("click", () => { els.matchOver.classList.add("hidden"); main.startNewMatch(); });
    foot.appendChild(nm);
  }
  const leave = document.createElement("button");
  leave.className = "btn btn-ghost";
  leave.textContent = "Leave";
  leave.addEventListener("click", () => main.leaveGame());
  foot.appendChild(leave);
  card.appendChild(foot);

  els.matchOver.appendChild(card);
  els.matchOver.classList.remove("hidden");
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

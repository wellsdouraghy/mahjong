// hud.js — turn banner, match bar, wall count, animated claim panel, winner overlay.
import * as main from "./main.js";
import * as scoreboard from "./scoreboard.js";
import { chipInfo, getFaceDataUrl } from "./tiles.js";

let els = {};

const ACTION_LABELS = {
  pon: "Pon", chi: "Chi", ron: "Ron", tsumo: "Tsumo", kong: "Kong", pass: "Pass",
};
const ACTION_HINT = {
  ron: "Complete your hand!", tsumo: "Self-draw win!",
  pon: "Take the pair", chi: "Take the run", kong: "Take all four", pass: "Skip",
};
const ROUND_WIND_LABEL = { wE: "East", wS: "South", wW: "West", wN: "North" };

// Human-readable label for a kong-able tile kind (e.g. "p5" -> "5 Dots").
const SUIT_WORD = { m: "Characters", p: "Dots", s: "Bamboo" };
const HONOR_WORD = {
  wE: "East Wind", wS: "South Wind", wW: "West Wind", wN: "North Wind",
  dR: "Red Dragon", dG: "Green Dragon", dW: "White Dragon",
};
function kindWord(kind) {
  if (!kind) return "";
  if (HONOR_WORD[kind]) return HONOR_WORD[kind];
  const suit = SUIT_WORD[kind[0]];
  if (suit) return `${kind.slice(1)} ${suit}`;
  return kind;
}

export function init() {
  els = {
    hud: document.getElementById("hud"),
    banner: document.getElementById("turn-banner"),
    matchBar: document.getElementById("match-bar"),
    matchProgress: document.getElementById("match-progress"),
    matchBalances: document.getElementById("match-balances"),
    wallNum: document.getElementById("wall-num"),
    claimPanel: document.getElementById("claim-panel"),
    claimHead: document.getElementById("claim-head"),
    claimButtons: document.getElementById("claim-buttons"),
    selfActions: document.getElementById("self-actions"),
    leaveBtn: document.getElementById("leave-game-btn"),
    scoreboardBtn: document.getElementById("scoreboard-btn"),
    turnGlow: document.getElementById("turn-glow"),
    fab: document.getElementById("fab"),
    fabToggle: document.getElementById("fab-toggle"),
    fabItems: document.getElementById("fab-items"),
    winnerOverlay: document.getElementById("winner-overlay"),
    winnerTitle: document.getElementById("winner-title"),
    winnerSubtitle: document.getElementById("winner-subtitle"),
    winnerTotal: document.getElementById("winner-total"),
    winningHand: document.getElementById("winning-hand"),
    winnerFans: document.getElementById("winner-fans"),
    backBtn: document.getElementById("back-to-room-btn"),
  };
  els.backBtn.addEventListener("click", () => main.backToRoom());
  els.leaveBtn.addEventListener("click", () => main.leaveGame());
  els.scoreboardBtn.addEventListener("click", () => scoreboard.toggle());
  initDock();
}

// Expandable bottom-right action menu. The ☰ toggle reveals the stacked actions;
// picking any action (or clicking elsewhere) collapses it again.
function setDockOpen(open) {
  if (!els.fab) return;
  els.fab.classList.toggle("open", open);
  if (els.fabToggle) els.fabToggle.setAttribute("aria-expanded", open ? "true" : "false");
}
function initDock() {
  if (!els.fabToggle) return;
  els.fabToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    setDockOpen(!els.fab.classList.contains("open"));
  });
  // Any action inside the menu collapses it after acting.
  if (els.fabItems) els.fabItems.addEventListener("click", () => setDockOpen(false));
  // Click anywhere outside the dock closes it.
  document.addEventListener("click", (e) => {
    if (els.fab && els.fab.classList.contains("open") && !els.fab.contains(e.target)) setDockOpen(false);
  });
}

export function update(state) {
  if (!state) return;

  els.wallNum.textContent = state.wallCount != null ? state.wallCount : "—";
  renderMatchBar(state);

  if (state.phase === "finished") {
    renderBanner(state, true);
    renderClaims([]);          // clear claim panel
    renderSelfKong(state);     // clear self-kong panel
    // v4 match flow: scoreboard.js owns the settlement popup / match-over overlay.
    // Only fall back to the legacy blocking winner overlay when there is no match.
    if (state.match) {
      els.winnerOverlay.classList.add("hidden");
    } else {
      renderWinner(state);
    }
    return;
  }

  els.winnerOverlay.classList.add("hidden");
  renderBanner(state, false);
  renderClaims(state.claimOptions ?? [], state);
  renderSelfKong(state);
}

function renderMatchBar(state) {
  // The top match strip (hand/round + balances) is hidden — the Scoreboard tab
  // (bottom-right) surfaces all of this now, so we keep the play area clean.
  els.matchBar.classList.add("hidden");
}

function setTurnGlow(on) {
  if (els.turnGlow) els.turnGlow.classList.toggle("active", !!on);
}

function renderBanner(state, finished) {
  if (finished) {
    els.banner.classList.remove("your-turn");
    els.banner.textContent = state.match ? "Hand over" : "Round over";
    setTurnGlow(false);
    return;
  }
  const you = state.yourSeat;
  const yourTurn = state.turn === you && state.turnPhase !== "claims";
  setTurnGlow(yourTurn);
  if (yourTurn) {
    els.banner.classList.add("your-turn");
    els.banner.textContent = "Your turn — click a tile to discard";
  } else {
    els.banner.classList.remove("your-turn");
    const p = state.players && state.players[state.turn];
    const name = p ? p.name : "…";
    if (state.turnPhase === "claims") {
      els.banner.textContent = "Claim window open…";
    } else {
      els.banner.textContent = `Waiting for ${name}…`;
    }
  }
}

function renderClaims(options, state) {
  if (!options || !options.length) {
    els.claimPanel.classList.add("hidden");
    els.claimButtons.innerHTML = "";
    els.claimHead.innerHTML = "";
    return;
  }

  // Order for display: winning actions first, kong before pon, pass last.
  const order = ["ron", "tsumo", "kong", "pon", "chi", "pass"];
  const sorted = [...options].sort((a, b) => order.indexOf(a) - order.indexOf(b));

  // Claimable tile from lastDiscard (or drawnTile for tsumo).
  const ld = state && state.lastDiscard;
  const tsumoTile = state && state.drawnTile;
  const claimTile = ld && ld.tile ? ld.tile : (options.includes("tsumo") ? tsumoTile : null);

  els.claimPanel.classList.remove("hidden");

  // Head: prompt + claimable tile chip.
  els.claimHead.innerHTML = "";
  const label = document.createElement("span");
  label.className = "claim-prompt";
  const hasWin = options.includes("ron") || options.includes("tsumo");
  label.textContent = hasWin ? "You can WIN!" : "You can claim!";
  els.claimHead.appendChild(label);
  if (claimTile) {
    els.claimHead.appendChild(makeChip(claimTile.kind, false));
  }

  // Buttons.
  els.claimButtons.innerHTML = "";
  for (const action of sorted) {
    const btn = document.createElement("button");
    btn.className = `claim-btn claim-${action}` + (action === "pass" ? " prominent-pass" : "");
    btn.innerHTML =
      `<span class="cb-label">${ACTION_LABELS[action] || action}</span>` +
      `<span class="cb-hint">${ACTION_HINT[action] || ""}</span>`;
    btn.addEventListener("click", () => {
      if (action === "chi") {
        const chiOpts = (state && state.chiOptions) || [];
        if (chiOpts.length > 1) { showChiPicker(state, chiOpts); return; }
        const t = chiOpts[0] && chiOpts[0].tiles;
        main.claimAction("chi", t ? t.map((x) => x.id) : undefined);
        renderClaims([]);
        return;
      }
      main.claimAction(action);
      renderClaims([]); // hide immediately after choosing
    });
    els.claimButtons.appendChild(btn);
  }
}

const CHI_SUIT_LABEL = { m: "Characters", p: "Dots", s: "Bamboo" };
const chiRank = (kind) => parseInt(String(kind).slice(1), 10) || 0;

// When a discard completes a run more than one way, let the player pick which run.
function showChiPicker(state, chiOpts) {
  const discard = state && state.lastDiscard && state.lastDiscard.tile;
  els.claimHead.innerHTML = "";
  const label = document.createElement("span");
  label.className = "claim-prompt";
  label.textContent = "Pick your run";
  els.claimHead.appendChild(label);
  if (discard) els.claimHead.appendChild(makeChip(discard.kind, false));

  els.claimButtons.innerHTML = "";
  for (const opt of chiOpts) {
    const ranks = opt.tiles.map((t) => chiRank(t.kind));
    if (discard) ranks.push(chiRank(discard.kind));
    ranks.sort((a, b) => a - b);
    const suit = discard ? (CHI_SUIT_LABEL[discard.kind[0]] || "") : "";
    const btn = document.createElement("button");
    btn.className = "claim-btn claim-chi";
    btn.innerHTML =
      `<span class="cb-label">${ranks.join("-")}</span>` +
      `<span class="cb-hint">${suit}</span>`;
    btn.addEventListener("click", () => {
      main.claimAction("chi", opt.tiles.map((t) => t.id));
      renderClaims([]);
    });
    els.claimButtons.appendChild(btn);
  }
  const back = document.createElement("button");
  back.className = "claim-btn prominent-pass";
  back.innerHTML = `<span class="cb-label">Cancel</span>`;
  back.addEventListener("click", () => renderClaims((state && state.claimOptions) || [], state));
  els.claimButtons.appendChild(back);
}

// v5: on YOUR turn, offer a Kong button per available kong kind. No timer.
function renderSelfKong(state) {
  const opts = (state && state.selfKongOptions) ?? [];
  const yourTurn = state && state.turn === state.yourSeat && state.turnPhase !== "claims";
  if (!els.selfActions) return;
  if (!yourTurn || !opts.length || state.phase === "finished") {
    els.selfActions.classList.add("hidden");
    els.selfActions.innerHTML = "";
    return;
  }

  els.selfActions.classList.remove("hidden");
  els.selfActions.innerHTML = "";

  const label = document.createElement("div");
  label.className = "self-kong-label";
  label.textContent = opts.length > 1 ? "Declare a Kong" : "Kong available";
  els.selfActions.appendChild(label);

  const row = document.createElement("div");
  row.className = "self-kong-row";
  for (const kind of opts) {
    const btn = document.createElement("button");
    btn.className = "self-kong-btn";
    btn.title = `Declare kong of ${kindWord(kind)}`;
    const lbl = document.createElement("span");
    lbl.className = "skb-label";
    lbl.textContent = "Kong";
    btn.appendChild(lbl);
    btn.appendChild(makeChip(kind, false));
    if (opts.length > 1) {
      const w = document.createElement("span");
      w.className = "skb-word";
      w.textContent = kindWord(kind);
      btn.appendChild(w);
    }
    btn.addEventListener("click", () => {
      main.declareKong(kind);
      els.selfActions.classList.add("hidden");
      els.selfActions.innerHTML = "";
    });
    row.appendChild(btn);
  }
  els.selfActions.appendChild(row);
}

function renderWinner(state) {
  const w = state.winner;
  els.winnerOverlay.classList.remove("hidden");
  els.winningHand.innerHTML = "";
  els.winnerFans.innerHTML = "";
  els.winnerTotal.classList.add("hidden");

  if (!w || w.winType === "draw" || !w.name) {
    els.winnerTitle.textContent = "Draw";
    els.winnerSubtitle.textContent = "The wall ran out — no winner this round.";
    return;
  }

  els.winnerTitle.textContent = `${w.name} wins!`;
  const typeLabel = w.winType === "tsumo" ? "Tsumo (self-draw)" : "Ron (off a discard)";
  els.winnerSubtitle.textContent = typeLabel;

  renderScore(w.score);

  const hand = w.hand || [];
  for (const t of hand) {
    els.winningHand.appendChild(makeChip(t.kind, false));
  }
  for (const meld of (w.melds || [])) {
    for (const t of (meld.tiles || [])) {
      els.winningHand.appendChild(makeChip(t.kind, true));
    }
  }
}

function renderScore(score) {
  if (!score) return;
  const total = score.total || 0;
  els.winnerTotal.textContent = `${total} point${total === 1 ? "" : "s"}`;
  els.winnerTotal.classList.remove("hidden");

  const fans = score.fans || [];
  for (const f of fans) {
    const row = document.createElement("div");
    row.className = "fan-row";
    const name = document.createElement("span");
    name.className = "fan-name";
    name.textContent = f.name;
    const pts = document.createElement("span");
    pts.className = "fan-points";
    pts.textContent = `+${f.points}`;
    row.appendChild(name);
    row.appendChild(pts);
    els.winnerFans.appendChild(row);
  }
}

// Shared 2D tile-chip renderer (reused by scoreboard.js).
export function makeChip(kind, isMeld) {
  const chip = document.createElement("div");
  chip.className = "tile-chip" + (isMeld ? " meld" : "");
  // Use the ACTUAL tile face (same canvas art as the 3D tiles) so chips match
  // what's on the table, instead of a stylized text approximation.
  const url = getFaceDataUrl(kind);
  if (url) {
    chip.style.background = "transparent";
    chip.style.border = "none";
    chip.style.overflow = "hidden";
    const img = document.createElement("img");
    img.src = url;
    img.alt = kind;
    img.draggable = false;
    img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit;";
    chip.appendChild(img);
    return chip;
  }
  // Fallback: the old text chip if the face texture couldn't be produced.
  const info = chipInfo(kind);
  chip.className = `tile-chip ${info.cls}` + (isMeld ? " meld" : "");
  const main = document.createElement("span");
  main.textContent = info.char;
  chip.appendChild(main);
  if (info.sub) {
    const sub = document.createElement("span");
    sub.className = "tc-sub";
    sub.textContent = info.sub;
    chip.appendChild(sub);
  }
  return chip;
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function reset() {
  els.banner.textContent = "";
  els.banner.classList.remove("your-turn");
  setTurnGlow(false);
  renderClaims([]);
  if (els.selfActions) { els.selfActions.classList.add("hidden"); els.selfActions.innerHTML = ""; }
  els.matchBar.classList.add("hidden");
  els.winnerOverlay.classList.add("hidden");
  if (els.winnerFans) els.winnerFans.innerHTML = "";
  if (els.winnerTotal) { els.winnerTotal.textContent = ""; els.winnerTotal.classList.add("hidden"); }
  els.wallNum.textContent = "—";
}

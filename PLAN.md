# Multiplayer 3D Mahjong — Architecture & Protocol Spec

This document is the single source of truth for both the server and the client.
Both must implement the protocol EXACTLY as written here.

## Overview

- **Server**: Node.js, plain `http` module + `ws` package. Serves static files from `public/`
  and `node_modules/three/build/three.module.js` at the URL path `/vendor/three.module.js`.
  Listens on port `3000` (or `process.env.PORT`). WebSocket endpoint is the same port, path `/ws`.
- **Client**: three.js (ES modules via import map: `"three"` → `/vendor/three.module.js`).
  No bundler. Plain JS modules under `public/js/`.
- **Game**: simplified Hong Kong-style mahjong, 4 seats, 136 tiles. Bots fill empty seats.
  No scoring — first player to complete a winning hand wins the round, then the room returns
  to "waiting" state so the host can start another round.

## File layout

```
package.json            (already created — deps: ws, three)
server/index.js         HTTP + static + WebSocket wiring, lobby/room management
server/game.js          Game engine: tiles, deal, turns, claims, win detection
server/bot.js           Bot decision logic
public/index.html       Lobby overlay + game HUD + canvas mount
public/style.css        All styling
public/js/main.js       Entry: WS connection, message dispatch, state store
public/js/lobby.js      Lobby UI (name form, room list, create/join/start)
public/js/scene.js      three.js world: table, tiles, layout, raycasting, animation
public/js/tiles.js      Tile face texture generation (canvas 2D) + tile mesh factory
public/js/hud.js        In-game HUD: turn indicator, buttons (Pon/Chi/Ron/Tsumo/Pass), winner overlay
```

## Tiles

Each physical tile has a unique integer `id` (0..135) and a `kind` string:

- Characters (man): `"m1"`..`"m9"` — rendered with Chinese numeral + 萬
- Dots (pin): `"p1"`..`"p9"` — rendered as circle patterns
- Bamboo (sou): `"s1"`..`"s9"` — rendered as stick patterns (s1 traditionally a bird; a stylized bird or single stick is fine)
- Winds: `"wE"`(東), `"wS"`(南), `"wW"`(西), `"wN"`(北)
- Dragons: `"dR"`(中, red), `"dG"`(發, green), `"dW"` (white — blank face with blue border)

- Flowers (bonus tiles, ONE copy each): `"f1"`(梅 plum), `"f2"`(蘭 orchid), `"f3"`(菊 chrysanthemum),
  `"f4"`(竹 bamboo), `"g1"`(春 spring), `"g2"`(夏 summer), `"g3"`(秋 autumn), `"g4"`(冬 winter)

4 copies of each of the 34 standard kinds + 8 flower tiles = **144 tiles** (ids 0..143).
Tile objects on the wire: `{id, kind}`. Hidden tiles are never sent — only counts.

Suited tile faces (m/p/s) carry a small Arabic numeral (1-9) in the upper-left corner of
the face texture; flowers carry their number (1-4) similarly.

## Flowers

Flowers are never held in hand and never discarded. Whenever a player receives a flower
(initial deal or any draw), the server automatically exposes it into that player's
`flowers` array and draws a replacement tile from the wall, repeating until a non-flower
arrives (wall exhaustion during replacement → draw game). After the initial deal, the
server resolves all dealt flowers in seat order before the dealer's first turn. Each
flower is worth **+1 point** to the winner's final score, listed as fan
`{name: "Flower Tiles", points: <count>}` — flower points do NOT count toward the
8-point MCR win minimum (the hand must reach 8 without them).

**Replacement draws come from the BACK of the wall** (the opposite end from normal
turn draws), as on a real table: normal draws pop the front, flower replacements pop
the back. `gameState.state` carries `wallBackTaken` — the total number of tiles taken
from the back for replacements this round — alongside `wallCount` (remaining), so the
client can deplete the two ends of the visual wall independently. Clients treat a
missing `wallBackTaken` as 0.

## Game rules (server enforces)

- 4 seats (0..3). Seat 0 = first joiner = dealer (East). Turn order 0→1→2→3→0.
- Deal: 13 tiles each; dealer's turn starts with a draw (so dealer has 14 after draw).
- Turn: current player draws (server auto-draws for them → `drawnTile`), then must discard
  one tile (any tile from hand or the drawn tile). Clicking a tile = discard it.
- If the drawn tile completes a winning hand, server includes `"tsumo"` in `claimOptions`
  for that player; they may declare tsumo (win) or discard normally.
- After a discard, a **claim window** opens for the other 3 players. Server computes each
  player's options against the discarded tile:
  - `"ron"` — discard completes their winning hand
  - `"pon"` — they hold 2 matching tiles
  - `"chi"` — ONLY the player to the discarder's left (next in turn order); they hold two
    suit tiles forming a run with the discard. If multiple chi shapes exist, server picks
    the lowest run automatically.
  - Players with ≥1 option get `claimOptions` (always including `"pass"`). Window resolves
    when all eligible players respond OR after a 7-second server timeout (timeout = pass).
  - Priority: ron > pon > chi. On a claim, tile moves to claimer's `melds` (face-up),
    claimer must then discard (turnPhase "discard", no draw). On all-pass, next player draws.
- Win check (14 tiles incl. melds×3 each): standard = 4 sets (pung = 3 identical, chow =
  3 consecutive same-suit) + 1 pair; OR seven pairs (concealed hand only). No yaku/score.
- Wall empty + discard unclaimed → draw game (`winner: null`, phase `"finished"`).
- Bots: on their turn, after ~800ms delay, they declare tsumo if they can win, otherwise
  discard a reasonable tile (e.g. an isolated tile; random is acceptable). Bots claim ron
  if possible, otherwise pass all claims immediately.
- Disconnect mid-game: player is replaced by a bot (name keeps "(bot)" suffix). No rejoin.
- After `finished`, server keeps the room with status `"waiting"`; humans stay in it, bots
  are removed. Host can start again.

## WebSocket protocol

All messages are JSON: `{type: string, ...fields}`. Server must never crash on malformed
input — validate and reply `{type:"error", message}` instead.

### Client → Server

| type        | fields            | notes |
|-------------|-------------------|-------|
| `hello`     | `name`            | first message; name 1..20 chars, server sanitizes |
| `createRoom`| `roomName`        | creates room, auto-joins, sender becomes host |
| `joinRoom`  | `roomId`          | join if status "waiting" and < 4 humans |
| `leaveRoom` | —                 | leave current room (host leaves → next human becomes host; empty room deleted) |
| `startGame` | —                 | host only, room status "waiting"; fills empty seats with bots |
| `discard`   | `tileId` (number) | valid only on your turn, turnPhase "discard" (or "draw" with drawnTile — discarding the drawn tile or any hand tile is allowed once you've drawn; server auto-draws so effectively turnPhase is "discard" whenever it's your turn) |
| `claimAction` | `action`        | one of `"pon" "chi" "ron" "tsumo" "pass"` — must be in your current `claimOptions` |

### Server → Client

| type      | fields | notes |
|-----------|--------|-------|
| `welcome` | `playerId` | reply to hello |
| `lobby`   | `rooms`, `you` | sent on join/any lobby change to ALL connected clients not in a game. `rooms: [{id, name, hostName, playerNames: [..], status: "waiting"|"playing"}]`. `you: {playerId, name, roomId|null, isHost}` |
| `gameState` | `state` | personalized full snapshot — sent to every player in the room after EVERY state change. Client re-renders from this (diffing/animating as it likes). |
| `error`   | `message` | |

### `gameState.state` shape (personalized per recipient)

```js
{
  roomId, roomName,
  phase: "playing" | "finished",
  yourSeat: 0..3,
  turn: 0..3,                    // whose turn
  turnPhase: "discard" | "claims",
  wallCount: number,
  wallBackTaken: number,         // replacement tiles taken from the back of the wall
  players: [                     // ALWAYS length 4, index == seat
    { seat, name, isBot, connected, handCount,
      melds: [ {type:"pon"|"chi", tiles:[{id,kind}x3]} ],
      discards: [ {id,kind}, ... ],   // in discard order
      flowers: [ {id,kind}, ... ],    // exposed bonus tiles, in draw order
      isDealer: bool }
  ],
  yourHand: [ {id,kind}, ... ],  // sorted by kind (suit then rank), EXCLUDING drawnTile
  drawnTile: {id,kind} | null,   // only when it's your turn and you just drew
  lastDiscard: { seat, tile:{id,kind} } | null,  // most recent discard (during claims window)
  claimOptions: [ "pon"|"chi"|"ron"|"tsumo"|"pass", ... ],  // [] when none pending for YOU
  winner: null | { seat, name, winType: "tsumo"|"ron"|"draw",
                   hand: [{id,kind}...], melds: [...],
                   score: { total, fans: [ {name, points} ] } | null }  // "draw" => seat/name/hand/score null
}
```

### Scoring (Chinese Official / MCR)

Scoring follows `SCORING.md` (compiled from mahjongtime.com's 8-page Chinese Official
scoring reference). Implemented in `server/score.js` as
`scoreHand(handTiles, melds, ctx) -> {total, fans:[{name,points}]}` where ctx carries
win context (selfDrawn, seatWind, lastWallTile, discard-completed, fully concealed, …).
**Win requirement: ANY valid winning shape wins — first to mahjong, no point minimum.**
(The MCR 8-point minimum is intentionally NOT enforced in this game.) A win (tsumo/ron)
is offered/allowed whenever the hand forms a complete winning shape, regardless of
score. The scorer still runs to produce the fan breakdown for display (a hand may
legitimately total 0 points plus any flowers). Kong-based fans are out of scope (engine
has no kongs). The winner overlay shows the fan breakdown and total (may be 0 + flowers).

Sorting order for `yourHand`: suit order m, p, s, w(ESWN), d(RGW), then rank ascending.

## Client presentation spec — v3 revisions

These REPLACE the corresponding v2 items where they conflict:

- **Chairs for everyone**: all four seats get a proper chair at the table; avatars SIT
  IN the chairs at correct seated height (hips on the seat pan, torso above table
  edge, never intersecting the tabletop). Your own seat has a chair too (visible when
  looking down/around); no avatar body needed at your own seat.
- **Mouse-follow camera (replaces drag-orbit)**: the camera stays planted at your
  chair. The view gently follows the mouse position over the canvas — cursor toward an
  edge eases the view that way (yaw roughly ±25°, pitch roughly ±12°, smoothed/lerped
  each frame, easing back to center when the pointer leaves the canvas). NO click-drag
  rotation at all; plain click on a tile discards as always (no drag threshold needed
  anymore). Keep clamped wheel zoom; double-click/Esc reset may remain as a no-op or
  recenter.
- **Rounded tiles**: tile meshes get visibly rounded-over edges/corners (beveled
  rounded-box geometry — e.g. an extruded rounded-rect with bevel, or a manual
  rounded-box builder; three's examples RoundedBoxGeometry is NOT available via
  /vendor). Face textures must still map cleanly to the front face.
- **Angled walls**: the draw-wall square is arranged like on a real table — the whole
  square rotated ~20° relative to the table/hands in a pinwheel/staggered fashion so
  each side's wall sits at an angle in front of its player.
- **Two-ended wall depletion**: normal draws visibly deplete the wall from the FRONT
  end; flower replacement draws visibly deplete it from the BACK end (use
  `wallBackTaken`, default 0 if absent). The back end thus keeps its 2-high stacks
  standing until a replacement is actually taken — matching "replacements come off the
  back of the deck".

## Client presentation spec — v2 additions

- **Classroom environment**: the mahjong table sits in a stylized low-poly classroom —
  wood/linoleum floor, four walls, a chalkboard with canvas-drawn scribbles, a poster or
  two, windows admitting soft daylight, ceiling with simple fluorescent light fixtures,
  a door, and a few school desks/chairs pushed toward the walls. Keep geometry cheap
  (boxes/planes, canvas textures); must stay at 60fps.
- **Opponent avatars**: a stylized low-poly humanoid (torso, head, simple arms) seated at
  each of the three opponent seats behind their tile rack, each with a distinct shirt
  color. Name sprite floats above the head. On that player's turn the avatar is
  highlighted (e.g. emissive pulse / spotlight). Subtle idle animation (breathing bob).
  Bots and humans look the same (name distinguishes them).
- **Look-around camera**: dragging on the canvas rotates the view (yaw ~±75°, pitch
  limited between slightly-below-horizon and near-top-down) around your seat's
  viewpoint; releasing keeps the view. A click WITHOUT drag (movement under a small
  pixel threshold) still selects/discards tiles. Double-click (or Esc) resets to the
  default framing. No zoom/pan required; wheel zoom (clamped) is a nice-to-have.
- **Visible draw wall**: render the live wall as the classic square of face-down tiles
  stacked two high between the discard zone and the players' hands, with `wallCount`
  tiles present — stacks visibly deplete (consistent clockwise order) as tiles are
  drawn, so remaining tiles are readable at a glance. The wall square, discard grids,
  melds, flowers and hands must not overlap; enlarge the table if needed.
- **Flowers display**: each player's exposed flowers lie face-up in a row next to their
  melds area, visible to everyone.

## Client presentation spec

- **Lobby** (HTML overlay, dark elegant theme, mahjong-green accents): name entry once →
  room list with player names + Join buttons, "Create room" input+button, inside a room:
  player list, "Start game" (host only, enabled always — bots fill), "Leave".
- **World** (shown when `gameState` with phase `"playing"` arrives; lobby overlay hides):
  - Green felt round-cornered table, subtle wood rim, dark environment, warm key light +
    ambient; shadows on.
  - Camera: your seat is always the bottom (rotate seats by `yourSeat` so you're at the
    near edge). Approx camera pos (0, 13, 16) looking at (0, 0, 1).
  - **Your hand**: face-up row at near edge, standing and tilted ~30° toward camera so
    faces are readable. Drawn tile offset to the right with a gap. Hovering a tile lifts
    it slightly; clicking it sends `discard`. Only interactive when it's your turn.
  - **Opponents**: rows of face-down standing tiles (backs toward you) sized by
    `handCount`, at right/top/left edges. Name floating above each (canvas sprite),
    with a highlight/glow when it's their turn.
  - **Discards**: per-player grid (6 per row) of face-up flat tiles in the center region
    in front of each seat, oriented toward that seat. The latest discard briefly
    highlighted.
  - **Melds**: face-up tiles laid flat near each player's right-hand table corner.
  - **Turn indicator**: also in HUD text ("Your turn — click a tile to discard" / "Waiting
    for X…").
  - **Claim buttons**: when `claimOptions` non-empty, show big HUD buttons (Pon/Chi/Ron/
    Tsumo/Pass) — send `claimAction`.
  - **Winner overlay**: shows winner name + winType + their revealed hand (text/2D is fine),
    "Back to lobby" button → send `leaveRoom`... NO: button returns to room's waiting lobby
    view (room persists). Provide "Leave room" too.
  - Tile meshes: rounded-ish box ~ (0.9 × 1.2 × 0.62) units, ivory body, subtle green back
    face. Faces via canvas-generated textures (128×160 or similar), cached per kind.
  - Animate tile movements (discard flying to pile, draws) with simple lerps; snap is
    acceptable fallback but lerp preferred. Keep everything smooth at 60fps.
- Resize handling; pixel ratio capped at 2.

## Match play & money (v4)

The room now hosts a **16-hand match** with real-money-style scoring at **$1 per point**.

### Match structure
- A match = **16 hands** (4 rounds × 4 dealers). `handNumber` 1..16.
- **Round (prevalent) wind** advances every 4 hands: hands 1-4 = East (東), 5-8 = South
  (南), 9-12 = West (西), 13-16 = North (北).
- **Dealer** rotates each hand: dealer seat for hand h = `(h - 1) % 4` (hand 1 → seat 0).
- **Seat winds** are relative to the dealer: seat s wind index = `(s - dealer + 4) % 4`
  → 0=E,1=S,2=W,3=N. These feed the scorer's `seatWind`/`roundWind` context, so wind and
  dragon pungs, seat/round-wind fans, and flowers all score as normal MCR fans.
- Points per hand = the MCR `scoreHand` total (fans + flowers), **no 8-point minimum**
  (any valid winning shape wins — first to mahjong).

### Payment (per hand)
Let `P` = winner's point total for the hand, and `M_x` = player x's streak multiplier
(see below), evaluated BEFORE this hand's streak update.
- **Self-draw (tsumo)**: EACH of the other 3 players pays the winner. Pairwise amount
  from payer X = `P × max(M_winner, M_X)`.
- **Win off a discard (ron)**: ONLY the discarder pays the winner, amount
  `P × max(M_winner, M_discarder)`.
- **Draw game**: no payment.
- Each player's running balance (`balance`, integer dollars, may be negative) accumulates
  across the 16 hands.

### Streak multiplier
- Each player has a consecutive-win `streak` (starts 0) and derived multiplier
  `M = streak >= 3 ? 3 : streak === 2 ? 2 : 1` (win once → 1×, twice in a row → 2×,
  three or more → 3×, capped at 3×).
- The multiplier is **symmetric**: it scales both the money a streaking player wins and
  the money they pay while the streak is live (via the `max(M_winner, M_payer)` rule
  above — the streak-breaking loss is charged at the elevated rate, then resets).
- After a **decisive hand** (someone wins): winner's `streak += 1`; every other player's
  `streak = 0`.
- After a **draw hand**: every player's `streak = 0` (draws reset streaks).

### Match state in `gameState.state`
Add these fields (clients treat missing as sensible defaults):
```js
match: {
  handNumber,          // 1..16
  totalHands: 16,
  roundWind,           // "wE"|"wS"|"wW"|"wN"
  dealerSeat,          // 0..3 for this hand
  players: [ { seat, balance, streak, multiplier } x4 ],   // index == seat
}
```
Each `players[seat]` (the existing per-seat array) also gains `seatWind` ("wE".."wN").

The winner object gains a `settlement`:
```js
winner: { ..., score, settlement: {
  points,              // P
  winnerMultiplier,    // M_winner
  payments: [ { from: seat, to: seat, amount } ],  // who paid whom, post-multiplier
} }
```

### End of match
After hand 16 settles, the room enters a `matchOver` state (reuse `phase:"finished"`
with `match.handNumber === 16` and a `matchComplete: true` flag on the winner/state).
Client shows a final scoreboard (net $ per player). Host can start a fresh match
(resets balances, streaks, handNumber to 1). Between hands 1..15, after a short reveal
the server auto-advances to the next hand (deal, resolve flowers) without needing the
host to re-click Start.

### Flow between hands
On a hand ending (win or draw), broadcast the finished state (with settlement), wait
~6s (or a "Next hand" host action) so players see the result, then auto-deal the next
hand with the rotated dealer/round wind and updated balances. Keep humans in their
seats; disconnected humans stay bot-replaced for the rest of the match.

## Lobby: manual bots (v4)

Replace the old "auto-fill empty seats with bots on Start" behavior with explicit host
control:
- A room has 4 seats. Humans occupy seats as they join. The **host** can **Add Bot**
  (fills the next empty seat with a bot) and **Remove** a bot (frees its seat). Humans
  can still join any empty seat.
- **Start Game** is enabled only when all 4 seats are filled (any mix of humans + bots).
  So a host can start with 4 humans, or 2 humans + 2 added bots, etc.
- Protocol (client→server), host-only, room status "waiting":
  - `addBot` — add a bot to the next empty seat (no-op if full).
  - `removeBot` `{seat}` — remove the bot in that seat (ignored if seat holds a human).
- The `lobby` message's room objects gain
  `seats: [ {index, kind:"human"|"bot"|"empty", name} x4 ]` (index == seat) so the
  in-room panel can render each seat with an Add/Remove control and enable Start only
  when full. `startGame` now errors if any seat is empty.

## In-game HUD chrome (v4)

- **Leave button — bottom-LEFT corner**: leaves the match/room (same semantics as the
  old leave: mid-match → replaced by a bot for the rest of the match; returns you to the
  lobby). Clearly labeled, always visible in-game.
- **Scoreboard button — bottom-RIGHT corner**: toggles a scoreboard panel (see below).

## Scoreboard & settlement (v4)

Server tracks and exposes match history so the client can render a full scoreboard.

Add to `gameState.state.match`:
```js
history: [ {
  handNumber,
  winnerSeat,          // null on a draw
  winnerName,
  winType,             // "tsumo"|"ron"|"draw"
  points,              // P (0 on draw)
  fans: [ {name, points} ],       // winner's fan breakdown ([] on draw)
  winningHand: [ {id,kind} ],     // revealed 14 concealed+meld tiles ([] on draw)
  payments: [ {from, to, amount} ],  // post-multiplier ($; [] on draw)
} ],
ledger: [ [0,0,0,0], ... ]   // 4x4 matrix: ledger[a][b] = total $ a has paid b across the match
```

The **scoreboard panel** (client, opened by the bottom-right button) shows:
- **Games played**: `handNumber` of `totalHands` (e.g. "Hand 7 of 16").
- **Per-hand history**: a scrollable list, one row per completed hand — hand #, winner,
  win type, points, the winning hand rendered as small tile chips, and the payments made.
- **Who owes who**: derived from `ledger`. A **"Smart payments" toggle**:
  - OFF → raw pairwise net: for each pair (a,b), show the net of `ledger[a][b] -
    ledger[b][a]` as "a pays b $X" (only nonzero, netted per pair).
  - ON → **minimized settlement**: collapse everyone to net balances
    (`balance[p] = sum_b ledger[p][b]... ` i.e. net paid−received) and compute a minimal
    set of transfers that settles all debts (greedy: match biggest debtor to biggest
    creditor repeatedly). So if A owes B and B owes C, A pays C directly. Show the
    resulting short list of transfers.
  - Compute both entirely client-side from `ledger`/balances; the toggle just re-renders.
- Also show current running **balances** ($ net per player) and each player's **streak
  multiplier**.

## Claim affordance (v4)

Make claimable discards impossible to miss:
- When YOU have any `claimOptions` (pon/chi/ron/tsumo/pass), the claim buttons must be
  large, colored per action, and **pulse/animate** to draw the eye; show which tile is
  claimable (e.g. "Pon 🀙?"). A countdown ring/bar shows the ~7s window remaining.
- In the 3D scene, **highlight the just-discarded tile** you can claim (emissive glow /
  lift / ring marker) so the visual and the buttons agree.
- This covers BOTH out-of-turn claims (pon/kong/ron on anyone's discard) and the
  in-turn chow from the left neighbor — the player should never miss either.
- Optional: a soft chime when a claim window opens for you.

## Happier / more fun aesthetic (v4)

Brighten and enliven the whole presentation without hurting readability or 60fps:
- **Classroom**: warmer, brighter daylight; cheerful wall color, colorful posters,
  a rainbow/among-friends vibe; playful chalkboard doodles. Avatars get friendlier
  proportions and brighter, more varied outfits (and simple smiley faces are welcome).
- **Tiles**: keep faces legible, but warmer ivory, cheerful colored backs, soft
  shadows. Rounded corners (already added) reinforce the friendly feel.
- **UI (HTML/CSS)**: rounder cards, livelier accent colors (beyond just green — a fun
  multi-hue palette), bouncy button hovers, celebratory winner/settlement animations
  (confetti-ish is fine if cheap). Keep it tasteful and fast.

## v5: Kongs, dead wall, room codes, claim flow, breakdowns

### Kongs (now IN scope)
Three kong types, all trigger a **replacement draw from the dead wall (back)**:
- **Concealed kong** (4 identical in hand): declared on YOUR turn (after your draw).
  Tiles move to melds as `{type:"kong", concealed:true, tiles:[4]}`. Draw replacement,
  then continue your turn (discard, or another kong, or win). Scores **Concealed Kong (2)**.
- **Melded kong from a discard** (you hold 3, someone discards the 4th): claimable in the
  claim window as action `"kong"`. Tiles → `{type:"kong", concealed:false, tiles:[4]}`.
  Draw replacement, then discard. Scores **Melded Kong (1)**. Priority in the claim
  window: **ron > kong = pung > chi** (kong and pung both need the discard; a player who
  can do either is offered both and picks).
- **Added kong** (you have an exposed pung and now hold/draw its 4th): declared on YOUR
  turn; the 4th tile is added to the existing exposed pung meld (becomes a kong). Draw
  replacement, then continue. Scores **Melded Kong (1)**. (Robbing-the-kong is a
  nice-to-have: another player holding the winning tile may ron on the added tile → fan
  "Robbing the Kong (8)". Implement if cheap; otherwise skip and note it.)

Multi-kong fans to enable in score.js: **Two Melded Kongs (4)**, **Three Kongs (32)**,
**Four Kongs (88)**, and **Melded Kong / Concealed Kong** singles above. Winning on a
kong replacement tile = **Out with Replacement Tile (8)** (implement if cheap).

**Protocol additions:**
- Client→server, on your turn: `declareKong {kind}` — server determines concealed vs
  added and validates. (Kong is only legal on your own turn after drawing.)
- Client→server, claim window: `claimAction {action:"kong"}`.
- `gameState.state` gains `selfKongOptions: [kind, ...]` — kinds the recipient may
  concealed-kong or added-kong right now (their turn only; [] otherwise), so the client
  shows a **Kong** button on your turn. `claimOptions` may include `"kong"`.
- Meld shape gains `type:"kong"` and `concealed:bool`; a kong meld has 4 tiles.

### No claim timer — open until you act
Remove the 7-second claim-window auto-timeout entirely. When you can claim
(pon/chi/kong/ron), the window stays open indefinitely until you either claim or
explicitly **Pass** — nothing auto-passes you. Resolution: the window resolves when every
eligible player has responded (bots respond instantly; humans must click). Priority
(ron > kong = pung > chi) still applies once responses are in. Only after you pass/claim
does play continue (next player draws). Keep the game from stalling only via bots being
instant; a human with an option simply must act.

### Dead wall / back-of-deck mechanic (fix)
Model the wall as a **live wall** (drawn from the FRONT for normal turn draws only) plus a
fixed-size **dead wall** kept at the back. Requirements:
- The dead wall always shows a small constant stack (target **4 tiles**, rendered as
  2-high stacks) at the back of the deck.
- **Flower and kong replacements** are taken from the **TOP of the dead-wall back
  stack**; after each such draw the dead wall is **backfilled from the tail end of the
  live wall** so it stays at its constant size (until the live wall is exhausted).
- **Normal turn draws come only from the FRONT of the live wall.**
- Fix the current "each of the four walls is missing one tile" rendering/counting bug —
  the full 144-tile wall must be laid out completely (17×2 per side is real mahjong, but
  match whatever total we deal; every dealt tile must have a slot; no side short a tile).
- `gameState` already carries `wallCount` (live tiles remaining) and `wallBackTaken`
  (replacements taken); add `deadWallCount` (tiles currently in the dead wall, normally
  the constant) if the client needs it. Draw-game triggers when the LIVE wall (front) is
  exhausted.

### Rooms: join by code + private rooms + stale cleanup
- On create, the server assigns each room a short human **join code** (e.g. 4–5 uppercase
  letters/digits, unambiguous charset, unique among live rooms). Return it to the host.
- Rooms are **private/unlisted by default**: the public "Rooms" list should NOT dump every
  room. Instead the lobby offers **Create Room** (shows your code to share) and **Join by
  Code** (enter a code to join). (A public list may remain as an option, but the ghost-room
  problem must be gone — see cleanup.) The `lobby` message conveys the current player's own
  room + code; joining is by code, not by browsing.
- **Stale cleanup**: empty rooms (no connected humans) are deleted immediately (already
  true on leave/disconnect) AND a periodic sweep removes any room whose humans are all
  disconnected. Ensure a disconnected ws always frees its seat and deletes the room if it
  empties, so no "trapped" rooms can appear.

### Points breakdown (winner display)
Wherever the winning hand + points are shown (winner overlay AND the between-hand
settlement popup AND the scoreboard history), show the **itemized fan breakdown**: one
line per fan with its name and points (e.g. "All Chows +2", "Concealed Hand +2",
"Flower Tiles +1"), summing visibly to the total, so it's clear WHY the number is what it
is. The `winner.score.fans` and flower fan already carry this — surface it fully, not just
a total.

### Layout fixes (3D)
- **Melds overflow**: a player's melds must never run off the right of the screen. Cap the
  row and wrap to a second row (or scale/compact) so all melds stay on-table and visible
  regardless of count (a hand can have up to 4 melds + pair; kongs are wider).
- **Discard pile overlap**: the center discard tiles must not stack on top of each other
  as they accumulate — grid them (e.g. 6–8 per row, wrapping into multiple rows per seat)
  within the seat's discard band, never overlapping.
- **Wall draw order**: when depleting a 2-high stack, remove the **TOP tile first, then the
  bottom** (currently reversed). Fix so the visual draw order reads correctly.

### Scoreboard overlay stacking
When the scoreboard panel is open it must render ABOVE the top-right "Connected" pill
(raise its z-index / let it overlap that pill) so nothing pokes through the panel.

## Non-goals

Riichi, rejoin-after-disconnect, persistence, auth. (Kongs are now IN scope — see v5.)

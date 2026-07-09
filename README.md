# 3D Multiplayer Mahjong

A browser-based multiplayer mahjong game rendered in three.js, with Chinese Official
(MCR) scoring. You play at a table in a low-poly classroom with seated opponent
avatars, a live draw wall that visibly depletes, and the full 144-tile set including
flowers.

- **Look around**: drag to rotate the view (click without dragging still discards);
  double-click or Esc resets, mouse wheel zooms.
- **Draw wall**: the classic square of face-down two-high stacks shrinks as tiles are
  drawn, so you can see how many remain.
- **Flowers**: the 8 flower/season tiles are auto-exposed with a replacement draw and
  score +1 each for the winner (on top of the 8-point hand minimum, per MCR).
- **Tile faces**: dots/characters/bamboo carry a western index numeral in the
  upper-left corner, playing-card style.

## Money match (16 hands)

A room is a **16-hand match** (4 rounds × 4 dealers) played for **$1 per point**.

- **Lobby**: the host fills the 4 seats with any mix of humans and bots (**Add Bot** /
  **Remove**); **Start** unlocks only when all four seats are filled.
- **Scoring**: full MCR fan points, and now that the dealer and round wind rotate each
  hand, seat winds, round winds, dragons, and flowers all count. First to a valid hand
  wins (no point minimum).
- **Payment**: self-draw (tsumo) → all three opponents pay you; win off a discard (ron)
  → only the discarder pays.
- **Streaks**: win twice in a row → 2×, three or more → 3× (capped). The multiplier is
  symmetric — it scales both what you win and what you pay while the streak is live, and
  a streak-breaking loss is billed at the elevated rate before it resets. Draws reset
  everyone's streak.
- **In-game chrome**: **Leave** (bottom-left), **Scoreboard** (bottom-right). The
  scoreboard shows hand number, running balances, streak multipliers, full per-hand
  history (winner, hand, points, payments), and **who-owes-who** with a **Smart
  payments** toggle that minimizes the transfers (if you owe X and X owes Y, you just
  pay Y).
- Hands auto-advance after a settlement reveal; after hand 16 a final standings overlay
  appears and the host can start a new match.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:3000 (set `PORT` to change). Open the URL in multiple
browsers/tabs to play with friends on your network — empty seats are filled with bots
when the host starts, so you can also play solo.

## How to play

1. Enter a name, then create a room (or join one from the live room list).
2. The host clicks **Start Game** — you enter the 3D table world.
3. Your tiles are face-up at the bottom; opponents sit across and beside you with
   face-down hands. On your turn the game auto-draws for you — **click a tile to
   discard it** (hover lifts it).
4. When another player's discard helps you, claim buttons appear: **Pon**, **Chi**
   (from the player to your left), **Ron** (win off a discard), **Tsumo** (self-drawn
   win) — or **Pass**.
5. Wins follow Chinese Official (MCR) rules: your hand must be worth **at least
   8 points** from the fan table (see `SCORING.md`, compiled from mahjongtime.com's
   8-page reference). The winner overlay shows the full fan breakdown.

## Architecture

- `server/index.js` — HTTP static server + WebSocket lobby/rooms (`ws`), bot fill-in,
  disconnect → bot replacement. Set `MAHJONG_DEBUG=1` for connection/message logs.
- `server/game.js` — game engine: 136-tile wall, deal, turn loop, claim windows
  (ron > pon > chi), win detection.
- `server/score.js` — MCR scorer: enumerates hand decompositions and scores all
  implemented fans with exclusion rules (kong/flower fans out of scope — no kongs
  or flowers in this engine).
- `server/bot.js` — bot turn/claim logic.
- `public/` — three.js client (no bundler): `scene.js` (3D world), `tiles.js`
  (canvas-generated tile faces), `lobby.js`, `hud.js`, `main.js` (WebSocket client).
- `PLAN.md` — architecture + wire-protocol spec. `SCORING.md` — the compiled MCR
  fan reference.

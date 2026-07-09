# Chinese Official (MCR) Mahjong Scoring Spec

**Source:** mahjongtime.com, "Chinese Official Mahjong Scoring", pages 1–8
(`chinese-official-mahjong-scoring.html` … `-8.html`), fetched 2026-07-09.

This document is the source of truth for the scoring engine. Fan names, point
values, and description text are taken verbatim from the site. Machine-checkable
definitions and implementation notes are added for the engine and are clearly
marked as such.

---

## 1. Win requirement and payment scheme (site pages 1 & 8)

- **Minimum to declare mahjong: 8 points**, excluding flowers. Flower tiles are
  scored separately and added *after* the 8-point threshold is met (a hand
  cannot reach 8 on flowers alone).
- **81/82 designated hands**, scores 1–88 points. (The site's own text says "81
  designated hands"; the numbered list runs 1–82 because *Flower Tiles* is
  enumerated as item 13. Treat Flower Tiles as a bonus, not a fan.)
- **Dealer (East)** receives no extra payment for winning and does **not** repeat
  the seat.
- Play continues until the last wall tile is used; no dead-wall reservation
  ("No Dead Tiles designated").

**Payment scheme (page 8):**
- **Win by discard:** winner receives `8 + hand_value` from the discarder, and a
  flat `8` from each of the other two players.
  → discarder pays `8 + hand_value`; each non-discarder pays `8`.
  → winner total = `hand_value + 24`.
- **Win by self-draw:** winner receives `8 + hand_value` from **each** of the
  three opponents.
  → winner total = `3 * (hand_value + 8)` = `3*hand_value + 24`.
- False-mahjong declarations are penalized (site notes a penalty; exact amount
  not specified on the fetched text).

`hand_value` = sum of all fan the hand qualifies for, applying the non-repeat /
implied-point exclusion rules in section 4.

---

## 2. Notation and machine-checkable model

A standard winning hand = **4 sets + 1 pair (head)**, 14 tiles. Special hands
(Seven Pairs, Knitted, Thirteen Orphans, Nine Gates) are enumerated exceptions.

**Tile model**
- Suits: `m` = Characters (Wan), `s` = Bamboo, `p` = Dots. Ranks 1–9.
- Honors: winds `E S W N`, dragons `R`(red/中) `G`(green/發) `Wh`(white/白).
- Terminals = rank 1 or 9 of a suit. Simples = ranks 2–8. Honors = winds+dragons.
- "Terminal-or-Honor" tile = terminal OR honor.

**Set model** (each set carries a `concealed` flag)
- `chow(suit, n)` = run `n,n+1,n+2` (n ∈ 1..7).
- `pung(tile)` = triplet.
- `kong(tile)` = quad; carries `concealed` (drawn all 4) vs `melded`
  (claimed / promoted from pung). A kong counts as its pung for set-pattern fan.
- `pair(tile)` = the head.

**Win-context flags available to the engine** (per task constraints)
- `self_drawn` (bool)
- `winning_tile` (the tile that completed the hand)
- `by_discard` (bool = !self_drawn); the discarded tile identity is known.
- per-set `concealed` / `melded`
- `fully_concealed` = no melded/claimed sets at all AND self-drawn.
- `concealed_hand` = no melded/claimed sets AND won on discard.
- seats known, dealer = East (fixed). Wall count known (→ last-tile detection).
- `wait_shape` derivable from concealed tiles + winning tile (edge/closed/single).

**Context the engine does NOT have (task constraints) → handling**
- Kongs — engine has no kong mechanic. All kong-dependent fan = **N/A (omit)**.
- Flowers — no flower tiles. Flower points = **N/A (omit)**.
- Round wind rotation — no round/prevalent wind tracking. Prevalent Wind = **N/A**.
- Robbing the kong, replacement-tile draws — no kong → **N/A**.

Each fan below is tagged **[HAND]** (decidable from the 14-tile decomposition
alone), **[CTX]** (needs a win-context flag the engine has), or
**[N/A]** (needs kong/flower/round context the engine lacks).

---

## 3. Fan table, grouped by point value

### 88 Points (7 hands)

| # | Name | Verbatim description | Machine-checkable definition | Tag |
|---|------|----------------------|------------------------------|-----|
| 76 | Big Four Winds | "A hand that includes Pungs (or Kongs) of all four Winds. Does not combine with All Pungs." | 4 sets are pung/kong of E, S, W, N (one each); 5th group = any pair. | [HAND] |
| 77 | Big Three Dragons | "A hand that includes Pungs (or Kongs) of all three Dragon tiles. Does not combine with Dragon Pung." | Pung/kong of R, G, Wh all present. | [HAND] |
| 78 | All Green | "A hand composed entirely of the 2,3,4,6,8 of Bamboos and the green Dragon tile. Combines with Half Flush. When green is not used, the hand combines with Full Flush." | Every tile ∈ {s2,s3,s4,s6,s8, G}. | [HAND] |
| 79 | Nine Gates | "Holding the 1,1,1,2,3,4,5,6,7,8,9,9,9 tiles in one of the suits, creating the nine-sided wait of 1,2,3,4,5,6,7,8,9. Does not combine with Full Flush, or with Pung of Terminals or Honors." | Concealed single suit; the 13 tiles before winning = 1112345678999 of one suit (waits on all 1–9). | [HAND] (concealed) |
| 80 | Four Kongs | "Any hand that includes four Kongs. They may be concealed or melded." | 4 sets are all kongs. | **[N/A]** kong |
| 81 | Seven Shifted Pairs | "A hand formed by seven pairs of the same suit, each shifted one up from the last. Fully Concealed may be combined if Self-Drawn." | 7 pairs, one suit, ranks are 7 consecutive values n..n+6. | [HAND] |
| 82 | Thirteen Orphans | "A hand created by singles of any 12 of the 1, 9, and Honor tiles, along with a pair of the 13th. Does not combine with All Types, Concealed Hand, or Single Wait." | Exactly the 13 terminal-or-honor kinds {m1,m9,s1,s9,p1,p9,E,S,W,N,R,G,Wh}, one doubled. | [HAND] |

### 64 Points (6 hands)

| # | Name | Verbatim description | Machine-checkable definition | Tag |
|---|------|----------------------|------------------------------|-----|
| 70 | All Terminals | "A hand consisting entirely of 1 and 9 tiles. Does not combine with Double Pung or No Honors." | Every tile is a suit terminal (rank 1 or 9). (Implies 4 pungs + terminal pair.) | [HAND] |
| 71 | Little Four Winds | "A hand that includes three Pungs of Winds and a head of the fourth Wind. Combines with Prevalent Wind and Seat Wind, but points for Big Three Winds are implied." | 3 wind pungs + pair = the 4th wind. | [HAND] |
| 72 | Little Three Dragons | "A hand that includes two Dragon Pungs, and a head of the remaining Dragon. Points for individual Dragon Pungs are not added." | 2 dragon pungs + pair = 3rd dragon. | [HAND] |
| 73 | All Honors | "A hand consisting entirely of honors. Can be formed with Pungs or Kongs, any of which may be concealed or melded. Combines with Dragon Pung, but points for All Pungs are implied." | Every tile is an honor (wind/dragon). 4 honor pungs + honor pair. | [HAND] |
| 74 | Four Concealed Pungs | "A hand that includes four Pungs achieved without melding. Does not combine with Fully Concealed Hand or All Pungs." | 4 pungs, all `concealed`; + pair. | [HAND] |
| 75 | Pure Terminal Chows | "A hand consisting of two each of the lower and upper terminal Chows in a single suit, and a head of five in the same." | One suit: chow(n,1)×2 + chow(n,7)×2 (i.e. 123,123,789,789) + pair of 5. | [HAND] |

### 48 Points (2 hands)

| # | Name | Verbatim description | Machine-checkable definition | Tag |
|---|------|----------------------|------------------------------|-----|
| 68 | Quadruple Chow | "Four Chows of the same numerical sequence in the same suit. Points for Pure Shifted Pungs, Tile Hog, and Pure Double Chow are all implied." | 4 identical chows(suit,n) + pair. | [HAND] |
| 69 | Four Pure Shifted Pungs | "Four sets in the same suit each shifted one up from the last." | pungs(suit, n),(n+1),(n+2),(n+3) + pair. | [HAND] |

### 32 Points (3 hands)

| # | Name | Verbatim description | Machine-checkable definition | Tag |
|---|------|----------------------|------------------------------|-----|
| 65 | Four Shifted Chows | "Four Chows in one suit each shifted over 1 or 2 numbers from the last, but not a combination of both." | 4 chows(suit) with a constant step of +1 (n,n+1,n+2,n+3) OR constant +2 (n,n+2,n+4,n+6). | [HAND] |
| 66 | Three Kongs | "A hand containing three Kongs. They may be melded or concealed." | Exactly 3 sets are kongs. | **[N/A]** kong |
| 67 | All Terminals and Honors | "A hand consisting entirely of 1, 9, and Honor tiles. Points for All Pungs and Pung of Terminals or Honors are implied." | Every tile is a terminal-or-honor; 4 pungs + pair (all terminal/honor). | [HAND] |

### 24 Points (9 hands)

| # | Name | Verbatim description | Machine-checkable definition | Tag |
|---|------|----------------------|------------------------------|-----|
| 56 | Seven Pairs | "A hand formed by seven pairs. Always finishes with a single wait. Does not combine with Concealed Hand, or Single Wait." | 7 pairs (any tiles). Must be concealed. | [HAND] |
| 57 | Greater Honors and Knitted Tiles | "Formed by 7 single Honors and singles of suit tiles belonging to separate Knitted sequences (for example, 1-4-7 of Bamboos, 2-5-8 of Characters, and 3-6-9 of Dots). Does not combine with All Types, Concealed Hand, or Single Wait." | All 7 honors present as singles + 7 singles drawn from the 3 knitted chains 147/258/369 each assigned to a distinct suit. 14 distinct singles. | [HAND] |
| 58 | All Even | "A hand formed with Pungs of 2, 4, 6 and 8 tiles and a head of the same. Points for All Pungs and All Simples are implied." | 4 pungs + pair, every tile rank ∈ {2,4,6,8}. | [HAND] |
| 59 | Full Flush | "A hand formed entirely of a single suit. The point for No Honors is implied." | Every tile same suit, no honors. | [HAND] |
| 60 | Pure Triple Chow | "Three runs of the same numerical sequence and in the same suit. Does not combine with Pure Shifted Pungs." | 3 identical chows(suit,n) + one more set + pair. | [HAND] |
| 61 | Pure Shifted Pungs | "Three Pungs of the same suit, each shifted one up from the last. Does not combine with Pure Triple Chow." | pungs(suit,n),(n+1),(n+2) + set + pair. | [HAND] |
| 62 | Upper Tiles | "A hand consisting entirely of 7, 8, and 9 tiles. The point for No Honors is implied." | Every tile rank ∈ {7,8,9}, suit tiles only. | [HAND] |
| 63 | Middle Tiles | "A hand consisting entirely of 4, 5, and 6 tiles. The point for No Honors is implied." | Every tile rank ∈ {4,5,6}, suit tiles only. | [HAND] |
| 64 | Lower Tiles | "A hand consisting entirely of 1, 2, and 3 tiles. The point for No Honors is implied." | Every tile rank ∈ {1,2,3}, suit tiles only. | [HAND] |

### 16 Points (6 hands)

| # | Name | Verbatim description | Machine-checkable definition | Tag |
|---|------|----------------------|------------------------------|-----|
| 50 | Pure Straight | "A hand using tiles 1-9 from any one suit, forming three consecutive Chows." | chows(suit,1),(4),(7) + set + pair. | [HAND] |
| 51 | Three-suited Terminal Chows | "A hand consisting of 1-2-3 + 7-8-9 in one suit (Two Terminal Chows), 1-2-3 + 7-8-9 in another suit, and finally, a head of fives in the remaining suit." | Suit A: 123+789; Suit B: 123+789; pair = 5 of suit C. | [HAND] |
| 52 | Pure Shifted Chows | "Three chows in one suit each shifted either one or two numbers up from the last, but not a combination of both." | 3 chows(suit), constant step +1 (n,n+1,n+2) OR constant +2 (n,n+2,n+4) + set + pair. | [HAND] |
| 53 | All Fives | "A hand in which every element includes a 5 tile." | Every set and the pair contains rank 5: chows must be 3-4-5,4-5-6,5-6-7; pungs/pair of 5. | [HAND] |
| 54 | Triple Pung | "Three Pungs, one in each suit, of the same number." | pungs(m,n),(s,n),(p,n) + set + pair. | [HAND] |
| 55 | Three Concealed Pungs | "Three Pungs achieved without claiming tiles." | ≥3 pungs (or kongs) flagged `concealed`. | [HAND] |

### 12 Points (5 hands)

| # | Name | Verbatim description | Machine-checkable definition | Tag |
|---|------|----------------------|------------------------------|-----|
| 45 | Lesser Honors and Knitted Tiles | "A hand made of singles of the following tiles: Any Honor tile, along with Suit Tiles that belong to different Knitted sequences" (all three suits use different knitted sequences). | 14 distinct singles from honors + the 3 knitted chains 147/258/369 (each chain tied to a distinct suit), with at least one honor missing (else it's #57). No pairs/sets. | [HAND] |
| 46 | Knitted Straight | "A special Straight which is formed not with standard Chows but with 3 different Knitted sequences. For example, 1-4-7 of Dots, 2-5-8 of Characters, and 3-6-9 of Bamboos." | The 9 tiles 1-9 split as knitted chains 147/258/369 each in a distinct suit (9 tiles) + one normal set + pair from remaining tiles. | [HAND] |
| 47 | Upper Four | "A hand created with suit tiles 6 through 9. The point for No Honors is implied." | Every tile rank ∈ {6,7,8,9}, suit tiles only. | [HAND] |
| 48 | Lower Four | "A hand created with suit tiles 1 through 4. The point for No Honors is implied." | Every tile rank ∈ {1,2,3,4}, suit tiles only. | [HAND] |
| 49 | Big Three Winds | "A hand that includes one Pung (or Kong) each of three winds." | Pung/kong of 3 different winds. | [HAND] |

### 8 Points (10 hands)

| # | Name | Verbatim description | Machine-checkable definition | Tag |
|---|------|----------------------|------------------------------|-----|
| 35 | Mixed Straight | "A straight (tiles 1-9) formed by Chows from all three suits." | chow(A,1)+chow(B,4)+chow(C,7) with A,B,C the three distinct suits + set + pair. | [HAND] |
| 36 | Reversible Tiles | "A hand created entirely with those tiles which are vertically symmetrical (245689 bamboos, 1234589 dots, White dragon). The point for One Voided Suit is implied." | Every tile ∈ {s2,s4,s5,s6,s8,s9, p1,p2,p3,p4,p5,p8,p9, Wh}. | [HAND] |
| 37 | Mixed Triple Chow | "Three runs of the same numerical sequence, one in each suit." | chow(m,n)+chow(s,n)+chow(p,n) + set + pair. | [HAND] |
| 38 | Mixed Shifted Pungs | "Three Pungs, one in each suit, each shifted up one number from the last." | pungs in 3 distinct suits with ranks n, n+1, n+2 (one per suit) + set + pair. | [HAND] |
| 39 | Chicken Hand | "A hand that would otherwise earn 0 points (the score from Flower Tiles do not count against this hand, and are added as a bonus beyond the 8 points for this hand)." | The decomposed hand scores 0 from all other fan (only qualifies when nothing else applies). | [CTX] (compute after all other fan) |
| 40 | Last Tile Draw | "Going out on a draw of the very last tile of the game. Does not combine with Self-drawn." | self_drawn AND wall_count == 0 after this draw. | [CTX] (wall count) |
| 41 | Last Tile Claim | "Going out off the discard which is the last tile in the game." | by_discard AND it is the last discard (wall exhausted). | [CTX] (wall count) |
| 42 | Out with Replacement Tile | "Going out on the replacement tile drawn after achieving a Kong. Does not apply to replacement tiles drawn for flower tiles." | Win on kong-replacement draw. | **[N/A]** kong |
| 43 | Two Concealed Kongs | "A hand including two concealed Kongs." | 2 sets are concealed kongs. | **[N/A]** kong |
| 44 | Robbing the Kong | "Winning off the tile that a player adds to a melded Pung to create a Kong. Does not combine with Fully Concealed Hand." | Win on tile promoting a melded pung to kong. | **[N/A]** kong |

### 6 Points (7 hands)

| # | Name | Verbatim description | Machine-checkable definition | Tag |
|---|------|----------------------|------------------------------|-----|
| 28 | All Pungs | "Formed by four Pungs (or Kongs) and a head." | 4 pungs/kongs + pair; no chows. | [HAND] |
| 29 | Half Flush | "Formed by tiles from any one of the three suits in combination with Honors." | Exactly one suit present + honors (≥1 honor, ≥1 suit tile). | [HAND] |
| 30 | Mixed Shifted Chows | "Three runs, one in each suit, each shifted over one tile up from the last." | chows in 3 distinct suits with ranks n, n+1, n+2 (one per suit) + set + pair. | [HAND] |
| 31 | All Types | "A hand in which each of the five elements is composed of a different type of tile (Characters, Bamboos, Dots, Winds, and Dragons)." | The 5 groups (4 sets+pair) use all 5 types: one m, one s, one p, one wind, one dragon group. | [HAND] |
| 32 | Melded Hand | "Every element of the hand must be completed with tiles discarded by other players. This means that all four sets must be claimed, and the player goes out on a single wait off another player. Points for Single Wait are implied." | All 4 sets `melded`/claimed; won by discard completing the pair (single wait). | [CTX] (melded + by_discard + wait) |
| 33 | Two Dragons | "Two Pungs (or Kongs) of Dragon tiles." | Pung/kong of 2 different dragons. | [HAND] |
| 34 | One Melded and one Concealed Kong | "A hand that includes one Melded Kong and one Concealed Kong." | 1 melded kong + 1 concealed kong. | **[N/A]** kong |

### 4 Points (4 hands)

| # | Name | Verbatim description | Machine-checkable definition | Tag |
|---|------|----------------------|------------------------------|-----|
| 24 | Outside Hand | "A hand that includes Terminals and Honors in each set, including the pair." | Every set and the pair contains ≥1 terminal-or-honor tile (chows must be 123 or 789; pungs/pair of terminal or honor). | [HAND] |
| 25 | Fully Concealed Hand | "A hand that a player completes without any melds, and wins by Self-Draw." | no melded/claimed sets AND self_drawn. | [CTX] |
| 26 | Two Melded Kongs | "Finishing a hand that contains two claimed Kongs." | 2 melded kongs. | **[N/A]** kong |
| 27 | Last Tile | "Going out off a tile which is the last of its kind... the first three tiles of its kind are in the discard piles or are used in claimed sets. Points for Robbing the Kong are not added." | Winning tile is the 4th (last) visible of its kind. | [CTX] (needs discard/meld visibility tracking) |

### 2 Points (10 hands)

| # | Name | Verbatim description | Machine-checkable definition | Tag |
|---|------|----------------------|------------------------------|-----|
| 14 | Dragon Pung | "A Pung or Kong of Dragon Tiles. May be concealed or melded." | ≥1 pung/kong of a dragon. | [HAND] |
| 15 | Prevalent Wind | "A Pung of the Table Wind which corresponds to the round in progress. May be concealed or melded." | Pung/kong of the round wind. | **[N/A]** no round wind (see notes) |
| 16 | Seat Wind | "A Pung or Kong of the Wind Tile, corresponding to the player's Seat position." | Pung/kong of the player's seat wind (East for dealer, etc.). | [CTX] (seat known) |
| 17 | Concealed Hand | "Having a concealed hand (no melded sets) and going out off a player's discard." | no melded sets AND by_discard. | [CTX] |
| 18 | All Chows | "A hand consisting of all runs and no honors." | 4 chows + pair; no honors, no pungs/kongs. | [HAND] |
| 19 | Tile Hog | "Using all four of a single suit tile without declaring them as a Kong." | Some suit tile appears 4× in hand, not as a kong (split across sets, e.g. pung+chow). | [HAND] |
| 20 | Double Pung | "Two Pungs of the same numbers in two different suits (2-2-2 Bamboos + 2-2-2 Dots)." | pung(suitA,n) + pung(suitB,n), A≠B. | [HAND] |
| 21 | Two Concealed Pungs | "Two Pungs which are achieved without claiming." | ≥2 pungs/kongs flagged `concealed`. | [HAND] |
| 22 | Concealed Kong | "Created when four identical tiles, all drawn, are declared as a Kong." | 1 concealed kong. | **[N/A]** kong |
| 23 | All Simples | "A hand formed without Terminal or Honor tiles." | No tile is a terminal-or-honor (all ranks 2–8, no honors). | [HAND] |

### 1 Point (13 items)

| # | Name | Verbatim description | Machine-checkable definition | Tag |
|---|------|----------------------|------------------------------|-----|
| 1 | Pure Double Chow | "Two runs of the same suit and same numerical sequence." | Two identical chows(suit,n). | [HAND] |
| 2 | Mixed Double Chow | "Two runs, one in each of two suits, of the same numerical sequence." | chow(A,n)+chow(B,n), A≠B. | [HAND] |
| 3 | Short Straight | "Two Chows in the same suit that run consecutively after one another." | chow(suit,n)+chow(suit,n+3). | [HAND] |
| 4 | Two Terminal Chows | "Runs of 1-2-3 and 7-8-9 in the same suit." | chow(suit,1)+chow(suit,7). | [HAND] |
| 5 | Pung of Terminals or Honors | "Each Pung of 1, 9, or Honor tiles scores 1 point." | Each pung/kong of a terminal or honor (scored per occurrence). | [HAND] |
| 6 | Melded Kong | "A Kong that was claimed from another player or promoted from a melded Pung." | 1 melded kong. | **[N/A]** kong |
| 7 | One Voided Suit | "A hand that lacks tiles from one of the three suits." | Exactly one of m/s/p suits is entirely absent. | [HAND] |
| 8 | No Honors | "A hand formed entirely of suit tiles." | No honor tiles present. | [HAND] |
| 9 | Edge Wait | "Waiting for a 3 or 7 when holding 1-2 or 8-9, respectively." | Winning tile completes a 123 via 12+3 or a 789 via 89+7, and that was the only wait. | [CTX] (wait shape) |
| 10 | Closed Wait | "Going out on a closed wait (for example, holding 2-4 and waiting on 3)." | Winning tile fills the middle gap of a chow (kanchan). | [CTX] (wait shape) |
| 11 | Single Wait | "Going out on a single wait (finishing a head)." | Winning tile completes the pair (tanki). | [CTX] (wait shape) |
| 12 | Self-drawn | "Going out with a tile drawn from the wall." | self_drawn. | [CTX] |
| 13 | Flower Tiles | "Each flower tile is worth 1 point." | +1 per flower, bonus outside the 8-pt threshold. | **[N/A]** no flowers |

---

## 4. Combination / exclusion rules (from the site's descriptions)

MCR's core principle: **non-repeat** — a set/tile pattern already counted for a
higher fan is not re-counted in a lower "implied" fan. The site states these
explicitly:

**Explicit "does not combine":**
- Seven Pairs (56) ✗ Concealed Hand, ✗ Single Wait.
- Greater Honors & Knitted Tiles (57) ✗ All Types, ✗ Concealed Hand, ✗ Single Wait.
- Pure Triple Chow (60) ✗ Pure Shifted Pungs (61) — mutually exclusive.
- All Terminals (70) ✗ Double Pung, ✗ No Honors.
- Four Concealed Pungs (74) ✗ Fully Concealed Hand, ✗ All Pungs.
- Big Four Winds (76) ✗ All Pungs.
- Big Three Dragons (77) ✗ Dragon Pung.
- Nine Gates (79) ✗ Full Flush, ✗ Pung of Terminals or Honors.
- Thirteen Orphans (82) ✗ All Types, ✗ Concealed Hand, ✗ Single Wait.
- Last Tile Draw (40) ✗ Self-drawn.
- Robbing the Kong (44) ✗ Fully Concealed Hand.
- Last Tile (27): Robbing-the-Kong points not added.

**Explicit "points implied / not added" (higher fan absorbs the lower):**
- Reversible Tiles (36) implies One Voided Suit.
- All Even (58) implies All Pungs + All Simples.
- Full Flush / Upper Tiles / Middle Tiles / Lower Tiles / Upper Four / Lower Four
  (59,62,63,64,47,48) imply No Honors.
- All Terminals and Honors (67) implies All Pungs + Pung of Terminals or Honors.
- Quadruple Chow (68) implies Pure Shifted Pungs + Tile Hog + Pure Double Chow.
- Little Four Winds (71) implies Big Three Winds (but combines with
  Prevalent/Seat Wind).
- Little Three Dragons (72): individual Dragon Pung points not added.
- All Honors (73) implies All Pungs (combines with Dragon Pung).
- Melded Hand (32) implies Single Wait.

**Combines (positive):**
- All Green (78) combines with Half Flush; with Full Flush if green dragon unused.
- All Honors (73) combines with Dragon Pung.
- Little Four Winds (71) combines with Prevalent Wind + Seat Wind.
- Seven Shifted Pairs (81) combines with Fully Concealed if self-drawn.

**General engine rule (standard MCR, applied on top of the above):** score the
highest-value fan a given group of tiles supports; do not double-count the same
physical tiles for two fan of the same category. Once the 8-point minimum is met,
sum all non-excluded fan.

---

## 5. Implementation notes

**Fan decidable from the 14-tile decomposition alone ([HAND]) — implement first:**
1,2,3,4,5,7,8,18,19,20,23 (1–2 pt); 24,28,29,30,31,33 (4–6 pt);
35,36,37,38 (8 pt); 45,46,47,48,49 (12 pt); 50,51,52,53,54,55 (16 pt);
56,57,58,59,60,61,62,63,64 (24 pt); 65,67 (32 pt); 68,69 (48 pt);
70,71,72,73,74,75 (64 pt); 76,77,78,79,81,82 (88 pt).
These need only the melds-vs-concealed flag per set (which the engine has) plus
pattern matching over ranks/suits/types.

**Fan needing win-context the engine HAS ([CTX]) — implement second:**
- `self_drawn`: 12 (Self-drawn), 25 (Fully Concealed Hand).
- `by_discard` + concealment: 17 (Concealed Hand), 32 (Melded Hand).
- `wait_shape` (derive from concealed tiles + winning tile): 9 (Edge), 10 (Closed),
  11 (Single).
- seat wind (dealer = East fixed): 16 (Seat Wind).
- wall count = 0: 40 (Last Tile Draw), 41 (Last Tile Claim).
- discard/meld visibility of the winning tile's 3 siblings: 27 (Last Tile) —
  requires tracking how many of that tile are already exposed; feasible with the
  discard pile + melds the engine sees.
- 39 (Chicken Hand): compute last — award only if every other fan scored 0.

**Fan the simplified engine CANNOT support ([N/A]) — omit / stub:**
- Kong-dependent (no kong mechanic): 6 (Melded Kong), 22 (Concealed Kong),
  26 (Two Melded Kongs), 34 (One Melded+one Concealed Kong), 42 (Out with
  Replacement Tile), 43 (Two Concealed Kongs), 44 (Robbing the Kong),
  66 (Three Kongs), 80 (Four Kongs). Also Tile Hog (19) is *not* a kong so it
  stays; but any fan whose only realization is a kong is dropped.
  → **Suggested handling: omit these fan entirely; they can never trigger.**
- Flowers (no flower tiles): 13 (Flower Tiles) and all flower bonuses.
  → **Suggested handling: omit flower points; they never apply. Note this shifts
    the practical low end of scoring since flowers can't pad toward 8.**
- Round/prevalent wind (no round rotation): 15 (Prevalent Wind).
  → **Suggested handling: N/A. If a single round is assumed (e.g. East round),
    the engine could optionally treat a pung of East as Prevalent Wind, but by
    default omit it. Seat Wind (16) is still supported since seats are known.**

**Special-shape detectors to build (bypass the normal 4-sets+pair search):**
Seven Pairs (56), Seven Shifted Pairs (81), Thirteen Orphans (82),
Nine Gates (79), Knitted-tile hands (45, 46, 57). Run these detectors before/
alongside standard decomposition and take the max-scoring interpretation.

**Kong→pung note:** wherever a fan says "Pung (or Kong)", the engine's pung
detector satisfies it; the kong-specific bonus fan are the only ones dropped.

---

## 6. Capture summary

Fans captured per point tier (site's own list, items 1–82):

| Points | Count | Fan numbers |
|--------|-------|-------------|
| 88 | 7 | 76–82 |
| 64 | 6 | 70–75 |
| 48 | 2 | 68–69 |
| 32 | 3 | 65–67 |
| 24 | 9 | 56–64 |
| 16 | 6 | 50–55 |
| 12 | 5 | 45–49 |
| 8 | 10 | 35–44 |
| 6 | 7 | 28–34 |
| 4 | 4 | 24–27 |
| 2 | 10 | 14–23 |
| 1 | 13 | 1–13 |
| **Total** | **82** | (81 fan + Flower Tiles bonus) |

**Pages:** all 8 fetched successfully on the first attempt. Pages 1–7 carried the
full fan catalog (1–82). Page 8 is an overview page (no per-fan list) and
supplied the payment scheme and win-requirement text in section 1. No gaps
required filling from external MCR knowledge; the only site-side ambiguity was
that the 8-point hands 40–44 rendered without a repeated "8" label, but they sit
under the page-4 "8 Points" header and match standard MCR values, so they are
recorded at 8 points.

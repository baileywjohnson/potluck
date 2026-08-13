# 🪙 Potluck

A multiplayer browser party game: players join a room, **bet play-money chips** on
who they think will win the upcoming minigame, then compete. Winning bettors split
the pot. Most chips after all rounds wins.

> Chips are **virtual play-money only** — there is no real-money wagering.

## Quick start

Requires **Node 22.5+** (for the built-in `node:sqlite` used by accounts).

```bash
npm install
npm start
# open http://localhost:3000 in a few browser tabs/devices
```

One player clicks **Create Room** and shares the 4-letter code; others **Join**.
The host starts the match. Open multiple tabs to play solo against yourself.

## Hosting

The server is **stateful**: rooms live in memory and gameplay uses WebSockets, so
it must run as a **single always-on instance** — no serverless, no autoscaling,
no replicas (rooms would split across instances).

### Render (one click via the included `render.yaml`)

1. Push to GitHub (already wired to `origin`).
2. In the [Render dashboard](https://dashboard.render.com): **New ➜ Blueprint**, pick
   this repo. It reads `render.yaml` and creates the web service (`npm ci` /
   `npm start`, Node 24, WebSockets + HTTPS handled). Or **New ➜ Web Service** and
   accept the auto-detected Node settings.
3. Deploy, then share the `https://<name>.onrender.com` URL.

`PORT` is injected by the host and read automatically — don't set it.

> **Free plan caveat:** the disk is ephemeral and the service spins down when
> idle, so **accounts/Stash reset on every restart or redeploy**. To keep them,
> use a paid instance with a **Disk** mounted at `/var/data` and set
> `POTLUCK_DB=/var/data/potluck.db`.

## The game loop

```
LOBBY → ( BETTING → COUNTDOWN → PLAYING → RESULTS ) × 5 rounds → GAME OVER
```

1. **Betting** — back any player (including yourself) with chips. Stakes are escrowed.
2. **Playing** — the round's minigame runs on the server (authoritative).
3. **Results** — winner revealed; the betting pool is paid out.

### Economy: bankroll, stakes, and spectators

Every player has a **persistent bankroll** that carries between matches, and you
start **broke** — low-stakes is the on-ramp where you earn one. Each lobby is one
of two stakes modes, chosen by the host:

- **Low-stakes** — the house stakes everyone a free even **50 chips at the start of
  the match**. There are *no* top-ups between minigames: you bet that stake across
  the whole match, and busting to 0 eliminates you to a spectator for the rest of
  it. Everyone gets a fresh 50 next match.
- **High-stakes** — the host sets a custom **buy-in** (e.g. 500) that each player
  pays *from their bankroll* to take a seat. Can't cover the buy-in → you sit the
  match out as a spectator. Bust to 0 mid-match → eliminated to a spectator.

Mechanically the two modes are the same — one stake per match that you have to
make last — the only difference is where the stake comes from (the house vs. your
bankroll) and whether affordability can keep you out.

### Levels & XP

Every player earns **XP** for each minigame they play (a base amount + a bit per
point scored + a bonus for winning). XP is persistent (like your bankroll) and
drives your **level** — each level costs a little more than the last. Your level
and an XP bar show in the wallet bar; levels also appear in the lobby and the
side-bets panel.

### Side Bets

Any two players can wager a **coin flip** from their bankrolls at any time (lobby
or mid-match) via the side-bets panel — challenge someone, they accept, the coin
decides. Independent of the poker pot.

### Chat

A **room chat** sits in the bottom-right, available the whole time you're in a
room (lobby through game over). Messages fan out to everyone over Socket.IO; the
server keeps a short backlog so anyone joining — or reconnecting — sees recent
history. The panel collapses, with an unread badge while it's tucked away.

Either way, at match end every participant's **leftover chips are banked** into
their bankroll, and the final standings show each player's net result. So
low-stakes is the casual grind to build a bankroll; high-stakes is where you put
it on the line.

**Spectators** watch everything live — the board, the minigame, the payouts — but
can't bet or play. Eliminated players return in the next match; anyone who
**joins a room mid-match** also starts as a spectator and plays the next one.

### Betting model — poker-style, bet on yourself

Each minigame is preceded by a **fixed-limit betting round** — you're wagering on
*yourself* to win the minigame:

1. The **button** posts a **blind** — the round's only forced money. It rotates
   every round, so nobody pays it twice in a row and **folding a hand you don't
   want costs you nothing**. The blind sits on the last seat to act, so it gets
   the option to check or raise when the action comes back around.
2. Action goes **around the table** (the first-to-act seat rotates each round to
   keep it fair). On your turn you can **check**, **bet**, **call**, **raise**, or
   **fold**. Bets and raises are a fixed increment, capped at a few per round.
3. **Fold** = drop out: you sit this minigame out and forfeit what you've put in.
4. The pot is **never divided** — whoever wins the minigame takes all of it. If
   everyone folds to one player, they win it uncontested (no minigame played).

   A few minigames can end with players genuinely level — two riders crashing
   head-on, the last survivors on an exhausted board, an identical score. Rather
   than splitting, the pot is then **drawn by lot** between them and the results
   screen says so ("Dead heat — X won the coin toss"). See
   `minigames/tiebreak.js`.

A per-turn timer keeps things moving — time out and you auto-check, or auto-fold
if there's a bet to you. Disconnect on your turn and it resolves the same way.
Blind and bet sizes scale to the stakes (10% / 20% of your starting stake), so it
feels the same in low- and high-stakes. Chips only ever move into the pot and out
to the winner, so the match economy is always conserved.

### Accounts & saved progress

Logging in is **optional** — you can still quick-play as a guest, where your Stash,
level and wins live only in memory and vanish when you leave. Create an account
(username + password) and that same progress is **saved and restored** across
sessions, devices, and server restarts. Passwords are hashed with scrypt (never
stored in plaintext); accounts and progress live in a local **SQLite** file
(`data/potluck.db`, via Node's built-in `node:sqlite` — no external service).

The login is kept in `localStorage` (so it persists across reloads and tabs),
separate from the per-tab room-reconnect token. When a logged-in player joins a
room their seat is **seeded** from their account, and changes are **written back**
at every money/XP event (buy-in, side-bet flips, each minigame's XP/win award, and
the end-of-match chip banking). Guests are untouched by any of this.

An account can be in **only one room at a time**: trying to create/join from a
second tab while you're still active elsewhere is refused (it tells you which room
you're in). If your old seat is merely *disconnected* — you closed the tab — it's
freed automatically so you're never locked out. Reclaiming your own seat
(`room:rejoin`) is always allowed. Guests have no cross-tab identity, so the rule
doesn't apply to them.

### Reconnection

A player's identity is a stable `playerId` plus a secret `token` (stored in the
browser), independent of the underlying socket. If you drop — a network blip or a
full page reload — your **seat is held open** for a grace period
(`RECONNECT_GRACE_MS`, default 60s): your chips, your live bet, and host status are
all preserved, and the match keeps running with your avatar idling. The client
auto-reclaims the seat on reconnect; others see you tagged **AWAY** meanwhile. If
the grace window expires you're removed for good (and the match returns to the
lobby if too few players remain).

### Minigames

The match rotates through the registry in `server/minigames/`.

**Coin Rush** — steer your avatar (WASD / arrow keys) around an arena and grab the
most coins in 20 seconds. Tap **Space** to lunge forward (≈5s cooldown), and
**left-click** to fire a shot that briefly **slows** whoever it hits. Fully
server-simulated — clients send a movement direction, a boost press, and an aim
point; the browser renders at the display's refresh rate, interpolating between
snapshots for smooth motion. Most coins takes the whole pot.

**Type Race** — a race to type a ~250-character paragraph correctly; each player
is a **colored slug** that crawls toward the finish line as their correct prefix
grows. A mistake stalls your slug until you fix it (backspace). First slug to the
finish wins (**winner-take-all**); if the timer runs out, the furthest-along wins.
The server scores the correct prefix from each player's submitted text, so progress
is authoritative. A 100 WPM typist finishes in about 30 seconds.

**Fruit Drop** — a competitive Suika: everyone has their own jar. Aim with the
mouse and **click / Space** to drop fruit; two of the same kind that touch **merge**
into the next size up and score. Most points when the 60s timer ends wins
(**winner-take-all**); overflow your jar past the top line and it freezes — you're
out, and an out jar can't take the pot however many points it banked first. The
server runs a compact circle-physics sim (gravity + a positional
collision solver + merging) for every jar. The jar is narrow with a low danger
line and bigger/more varied drops, so it fills fast. Rendered with pre-baked
glossy fruit sprites, interpolated falls, and merge-pop sparkles.

**Trapdoor** — a grid of tiles; **click** one to stand on it. Every few seconds a
random share of the tiles **drop away** — be somewhere safe. It runs until
exactly **one player is left standing**, and they take the whole pot. There's no
fixed drop count: each wave takes a bigger bite of the board and gives you less
time to think, so the field narrows fast however many started. Runs its own
internal place→drop→place loop.

**Lightcycles** — a competitive Tron. Your rider moves nonstop, leaving a solid
wall of light behind it; **steer with WASD / arrows** (90° turns, no reversing).
Crash into **any** trail — yours or a rival's — or the arena wall and you're out.
Last rider standing **takes the whole pot**. There's no real time limit: every
step consumes a cell, so the board fills and the round always resolves itself.
Server-authoritative grid stepping with a collision grid.

## Architecture

```
server/
  index.js            Express + Socket.IO; serves the client, routes events
  Room.js             Phase state machine, betting, scoring, broadcasts
  poker.js            Fixed-limit betting round (blind/check/bet/raise/fold)
  auth.js             Account signup/login/resume + scrypt hashing
  db.js               SQLite (node:sqlite) store for accounts + progress
  config.js           Tunables (env-overridable, e.g. BETTING_MS=2000)
  minigames/
    index.js          Registry + per-round selection
    tiebreak.js       Draws a single winner when a round ends level
    coinRush.js       Arena coin-collector (movement, boost, shoot)
    typeRace.js       Typing race (slugs to the finish line)
    suika.js          Competitive Suika fruit-merge (circle physics)
    trapdoor.js       Tile-drop survival (place → drop → split payout)
    lightcycle.js     Tron light-cycle duel (grid trails, last rider standing)
public/
  index.html · styles.css · client.js   Canvas client, phase-driven screens
```

The server is **authoritative**: it owns balances, the simulation, and outcomes;
clients render `state` snapshots and a fast `game:tick` stream during play.

## Adding a minigame

Create `server/minigames/yourGame.js` exporting
`{ id, name, blurb, create(players) }` where `create` returns an object
with `handleInput`, `update(dt) → done`, `getState()`, and
`getResult() → { winnerId, tiebreak, scores }`. Every minigame is
winner-take-all — `winnerId` gets the entire pot. If yours can end with players
genuinely level, use `decideWinner`/`drawFrom` from `./tiebreak.js` to draw one
winner and set `tiebreak: true` so the results screen can say the pot was decided
on a coin toss. Optional per-game actions
(`boost`, `shoot`, `handleType`, `aim`/`drop`, `place`, `turn`) hang off the
instance and are routed through
`Room.handleAction`. Register it in `minigames/index.js` and it joins the rotation.

### Graphics convention (the norm)

Canvas minigames should render to the shared **"enhanced" standard** — the bar set
by Coin Rush, Fruit Drop, and Trapdoor — not flat shapes. In `public/client.js`:

- **Draw via the rAF loop.** Buffer each `game:tick` into `snapshots` and let the
  `requestAnimationFrame` loop (`drawGame`) dispatch by `frame.mode`, so rendering
  runs at the display's refresh rate (and can interpolate positions by entity id
  for smooth motion).
- **Cache sprites.** Pre-render art once with the `sprite(lw, lh, draw)` helper
  (auto-supersampled to the device pixel ratio via `ensureCanvas`) and blit it —
  don't build gradients per frame. Reuse `ballSprite()`/`drawBall()` for player
  icons and `roundRectPath(...)` for panels.
- **A backdrop + particles.** Fill a gradient backdrop, and pop juice on key events
  (pickups, merges, eliminations) with `spawnBurst(...)` / `drawParticles(dt)`.

A purely DOM minigame (e.g. Type Race) instead leans on the parchment CSS theme
with shaded SVG art.

## Config / tuning

Any value in `config.js` can be overridden via an env var of the same name —
handy for fast playtesting:

```bash
BETTING_MS=5000 TOTAL_ROUNDS=3 STARTING_BANKROLL=2000 DEFAULT_BUYIN=250 npm start
```

Notable knobs: `STARTING_BANKROLL`, `LOW_STAKES_STIPEND`, `DEFAULT_BUYIN`,
`BLIND_FRACTION`, `BET_FRACTION`, `MAX_BETS`, `TURN_MS`, `TOTAL_ROUNDS`,
`RECONNECT_GRACE_MS`.

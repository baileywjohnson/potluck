# 🎲 Gamble Party

A multiplayer browser party game: players join a room, **bet play-money chips** on
who they think will win the upcoming minigame, then compete. Winning bettors split
the pot. Most chips after all rounds wins.

> Chips are **virtual play-money only** — there is no real-money wagering.

## Quick start

```bash
npm install
npm start
# open http://localhost:3000 in a few browser tabs/devices
```

One player clicks **Create room** and shares the 4-letter code; others **Join**.
The host starts the match. Open multiple tabs to play solo against yourself.

## The game loop

```
LOBBY → ( BETTING → COUNTDOWN → PLAYING → RESULTS ) × 5 rounds → GAME OVER
```

1. **Betting** — back any player (including yourself) with chips. Stakes are escrowed.
2. **Playing** — the round's minigame runs on the server (authoritative).
3. **Results** — winner revealed; the betting pool is paid out.

### Economy: bankroll, stakes, and spectators

Every player has a **persistent bankroll** (starts at 1000) that carries between
matches. Each lobby is one of two stakes modes, chosen by the host:

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

1. Every player in the match **antes** (a forced bet that seeds the pot).
2. Action goes **around the table** (the first-to-act seat rotates each round to
   keep it fair). On your turn you can **check**, **bet**, **call**, **raise**, or
   **fold**. Bets and raises are a fixed increment, capped at a few per round.
3. **Fold** = drop out: you sit this minigame out and forfeit what you've put in.
4. The pot is paid out per the minigame's **payout mode**:
   - `winner` (default) — **all or nothing**, the whole pot to the top scorer.
   - `proportional` — the pot is **split by score**, so everyone who scored wins
     a share. *Coin Rush* uses this: your cut scales with how many coins you grab.

   If everyone folds to one player, they win it uncontested (no minigame played).

A per-turn timer keeps things moving — time out and you auto-check, or auto-fold
if there's a bet to you. Disconnect on your turn and it resolves the same way.
Ante and bet sizes scale to the stakes (10% / 20% of your starting stake), so it
feels the same in low- and high-stakes. Chips only ever move into the pot and out
to the winner, so the match economy is always conserved.

### Reconnection

A player's identity is a stable `playerId` plus a secret `token` (stored in the
browser), independent of the underlying socket. If you drop — a network blip or a
full page reload — your **seat is held open** for a grace period
(`RECONNECT_GRACE_MS`, default 60s): your chips, your live bet, and host status are
all preserved, and the match keeps running with your avatar idling. The client
auto-reclaims the seat on reconnect; others see you tagged **AWAY** meanwhile. If
the grace window expires you're removed for good (and the match returns to the
lobby if too few players remain).

### Minigame: Coin Rush

Steer your avatar (WASD / arrow keys) around an arena and grab the most coins in
20 seconds. Fully server-simulated — clients only send a movement direction.

## Architecture

```
server/
  index.js            Express + Socket.IO; serves the client, routes events
  Room.js             Phase state machine, betting, scoring, broadcasts
  poker.js            Fixed-limit betting round (ante/check/bet/raise/fold)
  config.js           Tunables (env-overridable, e.g. BETTING_MS=2000)
  minigames/
    index.js          Registry + per-round selection
    coinRush.js       Reference minigame implementing the Minigame interface
public/
  index.html · styles.css · client.js   Canvas client, phase-driven screens
```

The server is **authoritative**: it owns balances, the simulation, and outcomes;
clients render `state` snapshots and a fast `game:tick` stream during play.

## Adding a minigame

Create `server/minigames/yourGame.js` exporting
`{ id, name, blurb, payout, create(players) }` where `create` returns an object
with `handleInput`, `update(dt) → done`, `getState()`, and
`getResult() → { winnerId, scores }`. Set `payout: 'winner'` (all or nothing) or
`payout: 'proportional'` (split the pot by score). Register it in
`minigames/index.js` and it joins the round rotation automatically.

## Config / tuning

Any value in `config.js` can be overridden via an env var of the same name —
handy for fast playtesting:

```bash
BETTING_MS=5000 TOTAL_ROUNDS=3 STARTING_BANKROLL=2000 DEFAULT_BUYIN=250 npm start
```

Notable knobs: `STARTING_BANKROLL`, `LOW_STAKES_STIPEND`, `DEFAULT_BUYIN`,
`ANTE_FRACTION`, `BET_FRACTION`, `MAX_BETS`, `TURN_MS`, `TOTAL_ROUNDS`,
`RECONNECT_GRACE_MS`.

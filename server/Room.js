import { randomUUID } from 'crypto';
import { CONFIG } from './config.js';
import { PokerRound } from './poker.js';
import { minigameForRound } from './minigames/index.js';
import { saveProgress } from './auth.js';

// Phases of a match. The room walks through:
//   LOBBY -> (BETTING -> COUNTDOWN -> PLAYING -> RESULTS)*N -> GAMEOVER -> LOBBY
export const Phase = {
  LOBBY: 'lobby',
  BETTING: 'betting',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  RESULTS: 'results',
  GAMEOVER: 'gameover',
};

// Split `pot` among items by weight, using largest-remainder rounding so the
// integer shares sum to `pot` exactly (no chips created or destroyed).
function splitByWeights(items, pot) {
  const totalW = items.reduce((s, it) => s + it.w, 0);
  if (totalW <= 0 || pot <= 0) return {};
  const shares = items.map((it) => {
    const exact = (it.w / totalW) * pot;
    const floor = Math.floor(exact);
    return { id: it.id, floor, rem: exact - floor };
  });
  const distributed = shares.reduce((s, x) => s + x.floor, 0);
  const leftover = pot - distributed;
  shares.sort((a, b) => b.rem - a.rem);
  const out = {};
  shares.forEach((s, i) => { out[s.id] = s.floor + (i < leftover ? 1 : 0); });
  return out;
}

// Map total XP to a level and progress within it. Each level costs a bit more
// than the last (level N -> N+1 needs N*100 XP), so leveling slows over time.
function levelInfo(xp) {
  let level = 1, need = 100, remaining = Math.max(0, Math.floor(xp || 0));
  while (remaining >= need) { remaining -= need; level++; need = level * 100; }
  return { level, xpInLevel: remaining, xpForLevel: need };
}

let nextRoomId = 1;
function makeRoomCode() {
  // Short human-friendly code, e.g. "PMK". Collisions are handled by caller.
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}

export class Room {
  constructor(io, code, onEmpty) {
    this.io = io;
    this.code = code;
    this.onEmpty = onEmpty;        // called when last player leaves
    this.internalId = nextRoomId++;

    this.players = new Map();      // playerId -> player object
    this.hostId = null;
    this.phase = Phase.LOBBY;

    // Stakes mode is set by the host in the lobby.
    //   'low'  — house gives everyone a free even stake each round; no bust.
    //   'high' — players pay a buy-in from their bankroll; busting eliminates.
    this.mode = 'low';
    this.buyIn = CONFIG.DEFAULT_BUYIN;

    this.round = 0;                // 1-based once a match starts
    this.minigame = null;          // registry entry for the current round
    this.game = null;              // live minigame instance during PLAYING
    this.poker = null;             // live PokerRound during BETTING (and held through the minigame)
    this.ante = 0;                 // ante + bet increment for the current match
    this.betSize = 0;
    this.lastResult = null;        // payload shown during RESULTS

    this.phaseEndsAt = 0;          // epoch ms when the timed phase flips
    this._phaseTimer = null;
    this._tickTimer = null;
    this._turnTimer = null;        // per-turn betting clock
    this.graceTimers = new Map();  // playerId -> timeout holding a seat open
    this.sideBets = new Map();     // challengeId -> { id, fromId, toId, amount } (pending coin-flip wagers)
    this.chat = [];                // recent chat messages (capped) — shared by everyone in the room
  }

  // ---- player lifecycle ----------------------------------------------------

  // A player's identity (id + secret token) is stable and survives socket
  // reconnects; `socketId` is just the current transport and may change.
  // `account` (optional) is a logged-in user's saved row; when present the
  // player's progress is seeded from — and later written back to — their
  // account. Guests pass null and keep the old ephemeral behaviour.
  addPlayer(socket, name, account = null) {
    const id = randomUUID();
    const token = randomUUID();
    // Joining once a match is underway means you watch this one and play the
    // next; in the lobby everyone is a prospective player.
    const role = this.phase === Phase.LOBBY ? 'player' : 'spectator';
    const player = {
      id,
      token,
      socketId: socket.id,
      userId: account?.id || null,        // links the seat to a saved account (null = guest)
      name: account ? account.username : (name || 'Player').slice(0, 16),
      bankroll: account ? account.bankroll : CONFIG.STARTING_BANKROLL, // persistent wallet
      xp: account ? account.xp : 0,       // persistent experience (earned per minigame)
      lifetimeWins: account ? account.wins : 0, // persistent win count (distinct from per-match wins)
      chips: 0,                           // per-match stake, assigned at match start
      role,                               // 'player' (in the match) | 'spectator'
      eliminated: false,                  // busted out of the current match
      connected: true,
      wins: 0,                            // minigames won this match (reset each match)
    };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    socket.join(this.code);
    this.broadcast();
    return player; // caller returns { playerId: id, token } privately to this socket
  }

  // Rebind an existing seat to a fresh socket after a drop or page reload.
  // The token is the secret proof that this is the same player.
  rejoin(token, socket) {
    const player = [...this.players.values()].find((p) => p.token === token);
    if (!player) return { error: 'Your session has expired.' };

    this.cancelGrace(player.id);
    player.socketId = socket.id;
    player.connected = true;
    socket.join(this.code);

    // If the seat's host slot is currently held by someone who's gone, hand
    // it to whoever just came back so the room is never stuck hostless.
    if (!this.players.get(this.hostId)?.connected) this.hostId = player.id;

    this.broadcast();
    return { ok: true, playerId: player.id };
  }

  // Called when a socket drops. We don't free the seat immediately — we mark
  // the player away and start a grace timer so they can rejoin.
  markDisconnected(playerId, socketId) {
    const player = this.players.get(playerId);
    if (!player) return;
    // Ignore a stale disconnect from an old socket the player already replaced.
    if (player.socketId !== socketId) return;

    player.connected = false;
    // Keep any pending side bets — a disconnect is usually just a refresh, and
    // the seat (with its challenges) is held through the grace window. They're
    // only cleared if the seat is permanently freed (see removePlayer).

    // Don't leave the host badge on an absent player.
    if (playerId === this.hostId) {
      const present = this.activePlayers()[0];
      if (present) this.hostId = present.id;
    }

    // Note: we deliberately do NOT abort the match here just because too few
    // players are currently connected — the match is held so they can rejoin
    // within the grace window. The under-min abort only happens if the seat
    // is permanently freed (see removePlayer).
    const timer = setTimeout(() => this.removePlayer(playerId), CONFIG.RECONNECT_GRACE_MS);
    this.graceTimers.set(playerId, timer);

    // If they dropped on their own betting turn, don't make the table wait out
    // the turn clock — resolve it now (auto-check, or fold facing a bet).
    if (this.phase === Phase.BETTING && this.poker && this.poker.toActId() === playerId) {
      this.advancePokerTurn();
    } else {
      this.broadcast();
    }
  }

  // Permanently free a seat (grace expired, or room torn down).
  removePlayer(id) {
    this.cancelGrace(id);
    this.cancelSideBetsFor(id);
    const wasHost = id === this.hostId;
    this.players.delete(id);

    if (this.players.size === 0) {
      this.cleanup();
      this.onEmpty(this.code);
      return;
    }
    if (wasHost) {
      const present = this.activePlayers()[0] || this.players.values().next().value;
      this.hostId = present.id;
    }

    if (this.phase !== Phase.LOBBY && this.participants().length < CONFIG.MIN_PLAYERS) {
      this.abortToLobby();
    }
    this.broadcast();
  }

  cancelGrace(playerId) {
    const t = this.graceTimers.get(playerId);
    if (t) { clearTimeout(t); this.graceTimers.delete(playerId); }
  }

  activePlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  // Players taking part in the current match (not spectators). Disconnected
  // participants are still included — their seat is held for reconnect.
  participants() {
    return [...this.players.values()].filter((p) => p.role === 'player');
  }

  // Connected players who would be allowed into a match if it started now.
  // Low-stakes: everyone. High-stakes: only those who can afford the buy-in.
  eligible() {
    return this.activePlayers().filter(
      (p) => this.mode === 'low' || p.bankroll >= this.buyIn
    );
  }

  // ---- match flow ----------------------------------------------------------

  // Host configures the lobby's stakes before starting.
  setMode(requesterId, mode, buyIn) {
    if (requesterId !== this.hostId) return;
    if (this.phase !== Phase.LOBBY) return;
    if (mode === 'low' || mode === 'high') this.mode = mode;
    if (this.mode === 'high') {
      const b = Math.floor(Number(buyIn));
      if (Number.isFinite(b) && b > 0) this.buyIn = b;
    }
    this.broadcast();
  }

  start(requesterId) {
    if (this.phase !== Phase.LOBBY) return { error: 'Match already started.' };
    if (requesterId !== this.hostId) return { error: 'Only the host can start.' };

    const eligible = this.eligible();
    if (eligible.length < CONFIG.MIN_PLAYERS) {
      return this.mode === 'high'
        ? { error: `Need ${CONFIG.MIN_PLAYERS}+ players who can afford the ${this.buyIn} buy-in.` }
        : { error: `Need at least ${CONFIG.MIN_PLAYERS} players.` };
    }

    // Seat everyone for the match: eligible players buy in (high) or get a
    // free stake (low); the rest sit out as spectators for this match.
    const eligibleIds = new Set(eligible.map((p) => p.id));
    for (const p of this.players.values()) {
      p.wins = 0;
      p.eliminated = false;
      if (this.mode === 'low' && p.connected) {
        p.role = 'player';
        p.chips = CONFIG.LOW_STAKES_STIPEND;
      } else if (this.mode === 'high' && eligibleIds.has(p.id)) {
        p.role = 'player';
        p.bankroll -= this.buyIn; // stake moves from wallet into the match
        p.chips = this.buyIn;
      } else {
        p.role = 'spectator';
        p.chips = 0;
      }
    }
    this.persistAll(); // high-stakes buy-ins moved money out of wallets — save it

    // Scale the ante and bet increment to the per-match stake so the betting
    // feels the same in low- and high-stakes.
    const stake = this.mode === 'high' ? this.buyIn : CONFIG.LOW_STAKES_STIPEND;
    this.ante = Math.max(1, Math.round(stake * CONFIG.ANTE_FRACTION));
    this.betSize = Math.max(1, Math.round(stake * CONFIG.BET_FRACTION));

    this.round = 0;
    this.finalStandings = null;
    this.beginBetting();
    return { ok: true };
  }

  beginBetting() {
    this.round += 1;
    if (this.round > CONFIG.TOTAL_ROUNDS) {
      this.beginGameOver();
      return;
    }

    this.applyRoundEconomy();
    // If a match can no longer be contested (everyone but one busted), wrap up.
    if (this.participants().length < CONFIG.MIN_PLAYERS) {
      this.beginGameOver();
      return;
    }

    this.minigame = minigameForRound(this.round - 1);
    this.game = null;
    this.lastResult = null;

    // Open the poker-style betting round for this minigame. Everyone antes;
    // the dealer position rotates each round so first-to-act stays fair.
    this.poker = new PokerRound(this.participants(), {
      ante: this.ante,
      betSize: this.betSize,
      betCap: CONFIG.MAX_BETS,
      dealerIndex: this.round - 1,
    });
    this.phase = Phase.BETTING;
    this.phaseEndsAt = 0;          // turn-based — paced by the per-turn clock
    this.advancePokerTurn();
  }

  // Run before each minigame's betting. In BOTH modes a player is staked once
  // at the start of the match and must make it last — there are no top-ups
  // between minigames — so anyone who has run dry is eliminated to a spectator
  // for the rest of this match (they're back with a fresh stake next match).
  applyRoundEconomy() {
    for (const p of this.participants()) {
      if (p.chips <= 0) {
        p.role = 'spectator';
        p.eliminated = true;
      }
    }
  }

  // A player took a betting action (check/call/bet/raise/fold).
  pokerAction(playerId, type) {
    if (this.phase !== Phase.BETTING || !this.poker) return { error: 'Betting is closed.' };
    const res = this.poker.act(playerId, type);
    if (res.error) return res;
    this.advancePokerTurn();
    return { ok: true };
  }

  // Drive the betting round: skip players who can't act (auto-resolving anyone
  // who's disconnected), then either close the round or arm the turn clock.
  advancePokerTurn() {
    this.clearTurnTimer();
    while (!this.poker.closed) {
      const id = this.poker.toActId();
      const p = this.players.get(id);
      if (p && p.connected) break;              // a present human can decide
      const legal = this.poker.legalActions(id);
      this.poker.act(id, legal && legal.check ? 'check' : 'fold');
    }
    if (this.poker.closed) { this.onBettingClosed(); return; }

    this.poker.turnEndsAt = Date.now() + CONFIG.TURN_MS;
    this._turnTimer = setTimeout(() => this.onTurnTimeout(), CONFIG.TURN_MS);
    this.broadcast();
  }

  onTurnTimeout() {
    if (this.phase !== Phase.BETTING || !this.poker) return;
    const id = this.poker.toActId();
    const legal = this.poker.legalActions(id);
    this.poker.act(id, legal && legal.check ? 'check' : 'fold');
    this.advancePokerTurn();
  }

  onBettingClosed() {
    this.clearTurnTimer();
    const contenders = this.poker.contenders();
    if (contenders.length <= 1) {
      // Everyone folded to one player — they win the pot without a minigame.
      this.awardUncontested(contenders[0]);
    } else {
      this.beginCountdown(); // -> minigame -> winner takes the pot
    }
  }

  // Pot goes to the last player standing; no minigame is played.
  awardUncontested(winnerId) {
    const winner = this.players.get(winnerId);
    const pot = this.poker.pot;
    if (winner) winner.chips += pot;
    if (winnerId) this.awardXp(winnerId, CONFIG.XP_BASE + CONFIG.XP_WIN); // still won the round
    const payouts = winnerId ? { [winnerId]: pot } : {};
    this.lastResult = this.buildResult({ winnerId, scores: [], uncontested: true, payouts });
    this.poker = null;
    this.setPhase(Phase.RESULTS, CONFIG.RESULTS_MS, () => this.beginBetting());
  }

  // ---- Side Bets (player-vs-player coin flips, settled from bankroll) -------
  // These run alongside the match and are independent of the poker pot.

  sideBetActive() {
    // Allowed in the lobby and during a match; only blocked on the final screen.
    return this.phase !== Phase.GAMEOVER;
  }

  // One player challenges another to a coin flip for `amount` from each bankroll.
  challengeSideBet(fromId, toId, amount) {
    if (!this.sideBetActive()) return { error: 'Side Bets are closed right now.' };
    const from = this.players.get(fromId);
    const to = this.players.get(toId);
    if (!from || !to || fromId === toId) return { error: 'Pick another player.' };
    if (!to.connected) return { error: `${to.name} is away.` };

    amount = Math.floor(Number(amount));
    if (!Number.isFinite(amount) || amount <= 0) return { error: 'Enter a positive amount.' };
    if (from.bankroll < amount) return { error: "That's more than your stash." };
    if (to.bankroll < amount) return { error: `${to.name} can't cover that.` };

    // Only one outstanding challenge per direction.
    for (const sb of this.sideBets.values()) {
      if (sb.fromId === fromId && sb.toId === toId) return { error: 'You already challenged them.' };
    }
    const id = randomUUID();
    this.sideBets.set(id, { id, fromId, toId, amount });
    this.broadcast();
    return { ok: true };
  }

  // The challenged player accepts (flip!) or declines.
  respondSideBet(playerId, challengeId, accept) {
    const sb = this.sideBets.get(challengeId);
    if (!sb || sb.toId !== playerId) return { error: 'That challenge is gone.' };

    if (!accept) { this.sideBets.delete(challengeId); this.broadcast(); return { ok: true }; }

    const from = this.players.get(sb.fromId);
    const to = this.players.get(sb.toId);
    // Don't resolve while the challenger is away (e.g. mid-refresh) — they'd
    // miss the flip and just see their stash change. Leave it pending for them.
    if (from && !from.connected) return { error: `${from.name} stepped away — try again when they're back.` };
    if (!from || !to || from.bankroll < sb.amount || to.bankroll < sb.amount) {
      this.sideBets.delete(challengeId);
      this.broadcast();
      return { error: 'Someone can no longer cover the bet.' };
    }
    this.sideBets.delete(challengeId);

    const fromWins = Math.random() < 0.5;
    const winner = fromWins ? from : to;
    const loser = fromWins ? to : from;
    loser.bankroll -= sb.amount;
    winner.bankroll += sb.amount;
    this.persist(from); this.persist(to); // wallets changed — save both

    // Broadcast the flip so everyone watches it resolve.
    this.io.to(this.code).emit('sidebet:flip', {
      id: sb.id, amount: sb.amount,
      fromId: from.id, fromName: from.name, toId: to.id, toName: to.name,
      winnerId: winner.id, winnerName: winner.name, loserId: loser.id,
    });
    this.broadcast();
    return { ok: true };
  }

  // Drop any pending challenges that involve a player (on disconnect/leave).
  cancelSideBetsFor(playerId) {
    let changed = false;
    for (const [id, sb] of this.sideBets) {
      if (sb.fromId === playerId || sb.toId === playerId) { this.sideBets.delete(id); changed = true; }
    }
    return changed;
  }

  beginCountdown() {
    this.setPhase(Phase.COUNTDOWN, CONFIG.COUNTDOWN_MS, () => this.beginPlaying());
  }

  beginPlaying() {
    // Only the players still in the hand (didn't fold) play the minigame.
    // Disconnected contenders are included — their avatar idles and they
    // resume control if they reconnect before the round ends.
    const contenders = this.poker.contenders().map((id) => this.players.get(id)).filter(Boolean);
    this.game = this.minigame.create(contenders);
    this.setPhase(Phase.PLAYING, null, null); // ends via simulation, not a timer

    const dt = 1 / CONFIG.TICK_HZ;
    let last = Date.now();
    this._tickTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.min(0.25, (now - last) / 1000); // clamp big stalls
      last = now;

      const done = this.game.update(elapsed);
      // Stream just the minigame state at tick rate (cheaper than full room).
      this.io.to(this.code).emit('game:tick', this.game.getState());
      if (done) this.endPlaying();
    }, 1000 * dt);
  }

  handleInput(playerId, input) {
    // Movement is optional — some minigames (e.g. Type Race) don't use it.
    if (this.phase === Phase.PLAYING && this.game) {
      this.game.handleInput?.(playerId, input);
    }
  }

  // Discrete actions (Space to lunge, left click to shoot, typing). Optional per minigame.
  handleAction(playerId, action, data) {
    if (this.phase !== Phase.PLAYING || !this.game) return;
    if (action === 'boost') this.game.boost?.(playerId);
    else if (action === 'shoot') this.game.shoot?.(playerId, data);
    else if (action === 'type') this.game.handleType?.(playerId, data);
    else if (action === 'aim') this.game.aim?.(playerId, data);
    else if (action === 'drop') this.game.drop?.(playerId);
    else if (action === 'place') this.game.place?.(playerId, data);
    else if (action === 'turn') this.game.turn?.(playerId, data);
  }

  endPlaying() {
    clearInterval(this._tickTimer);
    this._tickTimer = null;

    const result = this.game.getResult();
    const pot = this.poker.pot;
    // How the pot is divided depends on the minigame's payout mode.
    const payouts = this.computePayouts(result, pot);
    for (const [id, amount] of Object.entries(payouts)) {
      const p = this.players.get(id);
      if (p) p.chips += amount;
    }
    // A minigame may have several co-winners (e.g. Trapdoor survivors split).
    const winnerIds = (result.winners && result.winners.length)
      ? result.winners : (result.winnerId ? [result.winnerId] : []);
    const winnerSet = new Set(winnerIds);
    for (const id of winnerIds) { const w = this.players.get(id); if (w) { w.wins += 1; w.lifetimeWins += 1; } }

    // Award XP: everyone who played the minigame earns it (base + score + win bonus).
    for (const s of result.scores) {
      this.awardXp(s.id, CONFIG.XP_BASE
        + Math.min(CONFIG.XP_SCORE_CAP, Math.max(0, s.score) * CONFIG.XP_PER_SCORE)
        + (winnerSet.has(s.id) ? CONFIG.XP_WIN : 0));
    }

    this.persistAll(); // XP + lifetime wins changed this round

    this.lastResult = this.buildResult({ winnerId: result.winnerId, winners: winnerIds, scores: result.scores, payouts });
    this.poker = null;
    this.setPhase(Phase.RESULTS, CONFIG.RESULTS_MS, () => this.beginBetting());
  }

  awardXp(playerId, amount) {
    const p = this.players.get(playerId);
    if (p) p.xp = (p.xp || 0) + Math.max(0, Math.round(amount));
  }

  // Decide who gets what from the pot.
  //   'winner'       — the whole pot to the top scorer (all or nothing).
  //   'proportional' — split by score, so everyone who scored wins a share.
  computePayouts(result, pot) {
    const mode = this.minigame?.payout || 'winner';
    const scores = result.scores || [];
    if (pot <= 0 || scores.length === 0) {
      return result.winnerId ? { [result.winnerId]: pot } : {};
    }
    if (mode === 'proportional') {
      const totalScore = scores.reduce((s, x) => s + Math.max(0, x.score), 0);
      // If nobody scored, hand everyone their share back evenly.
      const items = scores.map((s) => ({ id: s.id, w: totalScore > 0 ? Math.max(0, s.score) : 1 }));
      return splitByWeights(items, pot);
    }
    if (mode === 'split') {
      // Split the pot evenly among the winners (one survivor, the finalists, or
      // — if everyone dropped together — the last group). Exact integer split.
      const ws = (result.winners && result.winners.length)
        ? result.winners : (result.winnerId ? [result.winnerId] : []);
      return ws.length ? splitByWeights(ws.map((id) => ({ id, w: 1 })), pot) : {};
    }
    return result.winnerId ? { [result.winnerId]: pot } : {};
  }

  // Summarize the round for the results screen. Reads pot/contributions from the
  // (still-live) poker round, so call this before clearing `this.poker`.
  buildResult({ winnerId, winners = [], scores, uncontested = false, payouts = {} }) {
    const pot = this.poker.pot;
    const contributed = this.poker.contributed;
    const folded = new Set(this.poker.folded);

    // Per-player chip outcome: what they put in vs. what they took.
    const breakdown = this.poker.order.map((id) => {
      const p = this.players.get(id);
      const inAmount = contributed.get(id) || 0;
      const won = payouts[id] || 0;
      return {
        id, name: p?.name, contributed: inAmount, folded: folded.has(id),
        won, net: won - inAmount,
      };
    });

    return {
      round: this.round,
      minigame: { id: this.minigame.id, name: this.minigame.name, payout: this.minigame.payout || 'winner' },
      winnerId,
      winnerName: winnerId ? this.players.get(winnerId)?.name ?? null : null,
      // Names of everyone splitting the pot (for "A & B split…" on the results screen).
      winnerNames: winners.map((id) => this.players.get(id)?.name).filter(Boolean),
      uncontested,
      pot,
      scores,
      breakdown,
    };
  }

  beginGameOver() {
    this.clearPhaseTimer();

    // Bank every participant's leftover chips into their persistent bankroll.
    // `net` is what the match changed their wallet by: pure winnings in
    // low-stakes, or winnings minus the buy-in they paid in high-stakes.
    const cost = this.mode === 'high' ? this.buyIn : 0;
    const standings = this.participants().map((p) => {
      const banked = p.chips;
      p.bankroll += banked;
      p.chips = 0;
      return {
        id: p.id, name: p.name, banked, bankroll: p.bankroll,
        wins: p.wins, net: banked - cost,
      };
    });
    this.persistAll(); // leftover chips were banked back into wallets

    // Match ranking: most chips banked wins.
    standings.sort((a, b) => b.banked - a.banked);

    this.finalStandings = {
      mode: this.mode,
      buyIn: this.mode === 'high' ? this.buyIn : 0,
      standings,
      // Players who watched this match (eliminated or sat out).
      spectators: [...this.players.values()]
        .filter((p) => p.role === 'spectator')
        .map((p) => ({ id: p.id, name: p.name, bankroll: p.bankroll })),
    };
    this.setPhase(Phase.GAMEOVER, null, null);
    this.broadcast();
  }

  // Host can return everyone to the lobby after a match (or we do it on abort).
  returnToLobby(requesterId) {
    if (requesterId !== this.hostId) return;
    if (this.phase !== Phase.GAMEOVER) return;
    this.abortToLobby();
  }

  abortToLobby() {
    this.clearTimers();
    this.phase = Phase.LOBBY;
    this.round = 0;
    this.game = null;
    this.minigame = null;
    this.poker = null;
    this.lastResult = null;
    this.finalStandings = null;
    this.sideBets.clear();
    // Everyone present becomes a prospective player again for the next match.
    for (const p of this.players.values()) {
      p.role = 'player';
      p.eliminated = false;
      p.chips = 0;
    }
    this.broadcast();
  }

  // ---- chat ---------------------------------------------------------------

  // Anyone in the room can post; messages fan out to everyone over 'chat:msg'.
  postChat(playerId, text) {
    const player = this.players.get(playerId);
    if (!player) return;
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
    if (!clean) return;
    const msg = { playerId, name: player.name, text: clean, ts: Date.now() };
    this.chat.push(msg);
    if (this.chat.length > 80) this.chat.shift(); // keep only recent backlog
    this.io.to(this.code).emit('chat:msg', msg);
  }

  // Recent backlog, handed to a socket as it joins/reconnects.
  chatHistory() { return this.chat; }

  // ---- account persistence ------------------------------------------------

  // Write a logged-in player's progress back to their account. No-op for guests.
  persist(player) {
    if (player?.userId) saveProgress(player.userId, { bankroll: player.bankroll, xp: player.xp, wins: player.lifetimeWins });
  }
  persistAll() { for (const p of this.players.values()) this.persist(p); }

  // ---- phase + broadcast plumbing -----------------------------------------

  setPhase(phase, durationMs, onTimeout) {
    this.clearPhaseTimer();
    this.phase = phase;
    this.phaseEndsAt = durationMs ? Date.now() + durationMs : 0;
    if (durationMs && onTimeout) {
      this._phaseTimer = setTimeout(onTimeout, durationMs);
    }
    this.broadcast();
  }

  // The authoritative room snapshot every client renders from. (The fast
  // per-tick minigame positions go over 'game:tick' separately.)
  getPublicState() {
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      mode: this.mode,
      buyIn: this.buyIn,
      ante: this.ante,
      betSize: this.betSize,
      round: this.round,
      totalRounds: CONFIG.TOTAL_ROUNDS,
      phaseEndsAt: this.phaseEndsAt,
      minigame: this.minigame
        ? { id: this.minigame.id, name: this.minigame.name, blurb: this.minigame.blurb, payout: this.minigame.payout || 'winner' }
        : null,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, bankroll: p.bankroll, chips: p.chips,
        role: p.role, eliminated: p.eliminated, wins: p.wins, connected: p.connected,
        authed: !!p.userId, // logged-in (progress saved) vs guest
        xp: p.xp || 0, ...levelInfo(p.xp), // level, xpInLevel, xpForLevel
      })),
      // Live betting-round state (pot, whose turn, commitments) when present.
      poker: this.poker ? this.poker.publicState() : null,
      // Pending player-vs-player side bets awaiting a response.
      sideBets: [...this.sideBets.values()],
      result: this.lastResult,
      finalStandings: this.finalStandings || null,
      config: {
        minPlayers: CONFIG.MIN_PLAYERS,
        lowStipend: CONFIG.LOW_STAKES_STIPEND,
        defaultBuyIn: CONFIG.DEFAULT_BUYIN,
      },
    };
  }

  broadcast() {
    this.io.to(this.code).emit('state', this.getPublicState());
  }

  clearPhaseTimer() {
    if (this._phaseTimer) { clearTimeout(this._phaseTimer); this._phaseTimer = null; }
  }
  clearTurnTimer() {
    if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; }
  }

  clearTimers() {
    this.clearPhaseTimer();
    this.clearTurnTimer();
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
  }

  cleanup() {
    this.clearTimers();
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
  }
}

export { makeRoomCode };

// One fixed-limit betting round that precedes a minigame.
//
// Flow: every participant antes (forced, seeds the pot), then play goes around
// the table once (or more, if there are raises). On your turn you can:
//   check  — pass, only when there's nothing to call
//   call   — match the current bet (all-in if you're short)
//   bet    — open the betting for a fixed increment (when nobody has bet)
//   raise  — increase the current bet by the fixed increment
//   fold   — drop out: you sit out the minigame and forfeit what you've put in
// The round closes once every player still in has matched the highest bet (or
// folded). Whoever wins the minigame then takes the whole pot; if everyone but
// one folds, that player wins it uncontested.
//
// This object mutates the passed-in player objects' `chips` directly as bets
// are made, so chips are never created or destroyed — they just move to `pot`,
// which the room hands to the winner.

export class PokerRound {
  // players: participant objects ({ id, chips, connected }) in seat order.
  // opts: { ante, betSize, betCap, dealerIndex }
  constructor(players, { ante, betSize, betCap, dealerIndex }) {
    this.betSize = betSize;
    this.betCap = betCap;          // max number of bet/raise actions this round
    this.pot = 0;
    this.currentBet = 0;           // highest committed (excluding antes)
    this.betLevel = 0;             // how many bet/raise actions have happened
    this.committed = new Map();    // id -> chips put in via betting (not ante)
    this.contributed = new Map();  // id -> total chips put in (incl ante)
    this.folded = new Set();
    this.allIn = new Set();
    this.lastAction = new Map();   // id -> last action this round (for the UI)
    this.closed = false;
    this.winnerByFold = null;
    this.turnEndsAt = 0;           // set by the room's per-turn timer

    this.playerById = new Map(players.map((p) => [p.id, p]));

    // Seat order, rotated so the player left of the dealer acts first.
    const ids = players.map((p) => p.id);
    const n = ids.length;
    const start = ((dealerIndex % n) + n) % n;
    this.order = ids.map((_, i) => ids[(start + i) % n]);
    // The dealer button sits on the last player to act (first-to-act is on their left).
    this.dealerId = this.order[n - 1];

    // Antes (dead money — they don't count toward the call amount).
    for (const p of players) {
      const a = Math.min(ante, p.chips);
      p.chips -= a;
      this.pot += a;
      this.committed.set(p.id, 0);
      this.contributed.set(p.id, a);
      if (p.chips === 0) this.allIn.add(p.id);
    }

    // Everyone who can act must act at least once.
    this.toActCount = this._canAct().length;
    this.toActIdx = 0;
    this._seekActor(false);
    if (this._canAct().length === 0) this.closed = true; // all all-in already
  }

  _canAct() {
    return this.order.filter((id) => !this.folded.has(id) && !this.allIn.has(id));
  }
  _liveIds() {
    return this.order.filter((id) => !this.folded.has(id));
  }
  toActId() {
    return this.closed ? null : this.order[this.toActIdx];
  }
  toCall(id) {
    return Math.max(0, this.currentBet - (this.committed.get(id) || 0));
  }

  // What the given player is allowed to do right now (null if not their turn).
  legalActions(id) {
    if (this.closed || this.toActId() !== id) return null;
    const p = this.playerById.get(id);
    const toCall = this.toCall(id);
    const underCap = this.betLevel < this.betCap;
    return {
      check: toCall === 0,
      call: toCall > 0,
      callAmount: Math.min(toCall, p.chips),
      bet: toCall === 0 && underCap && p.chips > 0,
      betAmount: Math.min(this.betSize, p.chips),
      raise: toCall > 0 && underCap && p.chips > toCall, // need extra beyond the call
      raiseTo: this.currentBet + this.betSize,
      fold: true,
    };
  }

  act(id, type) {
    if (this.closed) return { error: 'Betting is closed.' };
    if (this.toActId() !== id) return { error: "It's not your turn." };
    const p = this.playerById.get(id);
    const toCall = this.toCall(id);
    const legal = this.legalActions(id);

    const put = (amount) => {
      const a = Math.min(amount, p.chips);
      p.chips -= a;
      this.pot += a;
      this.committed.set(id, (this.committed.get(id) || 0) + a);
      this.contributed.set(id, (this.contributed.get(id) || 0) + a);
      if (p.chips === 0) this.allIn.add(id);
    };

    switch (type) {
      case 'check':
        if (!legal.check) return { error: "Can't check facing a bet." };
        this.toActCount--;
        break;
      case 'call':
        if (!legal.call) return { error: 'Nothing to call.' };
        put(toCall);
        this.toActCount--;
        break;
      case 'bet':
        if (!legal.bet) return { error: "Can't bet right now." };
        put(this.betSize);
        this.currentBet = this.committed.get(id);
        this.betLevel++;
        this.toActCount = this._canAct().filter((x) => x !== id).length; // others must respond
        break;
      case 'raise':
        if (!legal.raise) return { error: "Can't raise right now." };
        put(toCall + this.betSize);
        this.currentBet = this.committed.get(id);
        this.betLevel++;
        this.toActCount = this._canAct().filter((x) => x !== id).length;
        break;
      case 'fold':
        this.folded.add(id);
        this.lastAction.set(id, 'fold');
        if (this._liveIds().length === 1) {
          this.closed = true;
          this.winnerByFold = this._liveIds()[0];
          return { ok: true, closed: true };
        }
        this.toActCount--;
        break;
      default:
        return { error: 'Unknown action.' };
    }

    this.lastAction.set(id, type);
    this._seekActor(true);
    if (this.toActCount <= 0 || this._canAct().length === 0) this.closed = true;
    return { ok: true, closed: this.closed };
  }

  // Move the turn pointer to the next player who can act.
  _seekActor(step) {
    const n = this.order.length;
    if (step) this.toActIdx = (this.toActIdx + 1) % n;
    for (let i = 0; i < n; i++) {
      const id = this.order[this.toActIdx];
      if (!this.folded.has(id) && !this.allIn.has(id)) return;
      this.toActIdx = (this.toActIdx + 1) % n;
    }
  }

  // Players still in the hand (not folded) — the ones who play the minigame.
  contenders() {
    return this._liveIds();
  }

  publicState() {
    return {
      pot: this.pot,
      currentBet: this.currentBet,
      betSize: this.betSize,
      betLevel: this.betLevel,
      betCap: this.betCap,
      toActId: this.toActId(),
      turnEndsAt: this.turnEndsAt,
      dealerId: this.dealerId,
      order: this.order,
      committed: Object.fromEntries(this.committed),
      contributed: Object.fromEntries(this.contributed),
      folded: [...this.folded],
      allIn: [...this.allIn],
      lastAction: Object.fromEntries(this.lastAction),
      winnerByFold: this.winnerByFold,
    };
  }
}

// One fixed-limit betting round that precedes a minigame.
//
// Flow: the button posts a blind (the round's only forced money), then play goes
// around the table once (or more, if there are raises). On your turn you can:
//   check  — pass, only when there's nothing to call
//   call   — match the current bet (all-in if you're short)
//   bet    — open the betting for a fixed increment (when nobody has bet)
//   raise  — increase the current bet by the fixed increment
//   fold   — drop out: you sit out the minigame and forfeit what you've put in
// The round closes once every player still in has matched the highest bet (or
// folded). Whoever wins the minigame then takes the whole pot; if everyone but
// one folds, that player wins it uncontested.
//
// Only the button is ever forced in, and the button rotates every round, so
// folding a hand you don't like costs you nothing — you only put chips at risk
// when you choose to. (The blind sits on the last player to act so it gets the
// option to check or raise when the action comes back around — structurally the
// same as a big blind.)
//
// This object mutates the passed-in player objects' `chips` directly as bets
// are made, so chips are never created or destroyed — they just move to `pot`,
// which the room hands to the winner.

export class PokerRound {
  // players: participant objects ({ id, chips, connected }) in seat order.
  // opts: { blind, betSize, betCap, dealerIndex }
  constructor(players, { blind, betSize, betCap, dealerIndex }) {
    this.betSize = betSize;
    this.betCap = betCap;          // max number of bet/raise actions this round
    this.pot = 0;
    this.currentBet = 0;           // highest amount any one player has committed
    this.betLevel = 0;             // how many bet/raise actions have happened
    this.committed = new Map();    // id -> chips this player has put in the pot
    this.folded = new Set();
    this.allIn = new Set();
    this.lastAction = new Map();   // id -> last action this round (for the UI)
    this.closed = false;
    this.winnerByFold = null;
    this.turnEndsAt = 0;           // set by the room's per-turn timer
    this.blindId = null;           // who posted the blind this round
    this.blindAmount = 0;          // what they actually got in (may be short)

    this.playerById = new Map(players.map((p) => [p.id, p]));

    // Seat order, rotated so the player left of the dealer acts first.
    const ids = players.map((p) => p.id);
    const n = ids.length;
    const start = ((dealerIndex % n) + n) % n;
    this.order = ids.map((_, i) => ids[(start + i) % n]);
    // The dealer button sits on the last player to act (first-to-act is on their left).
    this.dealerId = this.order[n - 1];

    for (const p of players) this.committed.set(p.id, 0);

    // The blind: the round's one forced bet, posted by the button. It opens the
    // betting, so everyone else must call it or fold — but nobody else is in for
    // a chip until they choose to be. A short stack posts what it has.
    const buttonPlayer = this.playerById.get(this.dealerId);
    if (blind > 0 && buttonPlayer) {
      const a = Math.min(blind, buttonPlayer.chips);
      buttonPlayer.chips -= a;
      this.pot += a;
      this.committed.set(this.dealerId, a);
      this.currentBet = a;
      this.betLevel = 1;                  // the blind counts as the opening bet
      this.blindId = this.dealerId;
      this.blindAmount = a;
      if (buttonPlayer.chips === 0) this.allIn.add(this.dealerId);
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
    // The blind opens the betting, so 'bet' is normally unreachable — it only
    // applies if the room is configured with no blind at all. The button facing
    // no raise has toCall 0 but is still *raising* its own blind, so 'raise'
    // keys off whether betting is open rather than off having something to call.
    const opened = this.currentBet > 0;
    return {
      check: toCall === 0,
      call: toCall > 0,
      callAmount: Math.min(toCall, p.chips),
      bet: !opened && underCap && p.chips > 0,
      betAmount: Math.min(this.betSize, p.chips),
      raise: opened && underCap && p.chips > toCall, // need extra beyond the call
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
      folded: [...this.folded],
      allIn: [...this.allIn],
      lastAction: Object.fromEntries(this.lastAction),
      winnerByFold: this.winnerByFold,
      blindId: this.blindId,
      blindAmount: this.blindAmount,
    };
  }
}

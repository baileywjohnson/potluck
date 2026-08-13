// Trapdoor: a grid of tiles. Each player stands on a tile. Every CHOOSE_S
// seconds a random set of tiles drops away — anyone standing on one is out.
// Survivors get another window to stay or move, then another drop, and so on
// until exactly ONE player is left standing — they take the whole pot.
//
// There's no fixed drop count: each wave takes a bigger bite of the board and
// gives players less time to think, so the field converges quickly however many
// start. In the rare case where a wave takes everyone still standing (or the
// board runs out of tiles under the last few), the pot is drawn by lot from that
// group rather than split — see ./tiebreak.js.
//
// This minigame runs its own internal timeline via update(dt).

import { decideWinner, drawFrom } from './tiebreak.js';

const COLS = 7, ROWS = 5;
const N = COLS * ROWS;
const CHOOSE_S = process.env.TRAPDOOR_CHOOSE ? Number(process.env.TRAPDOOR_CHOOSE) : 10;
const CHOOSE_MIN_S = 4;    // the thinking window shrinks toward this each wave
const FALL_ANIM_S = 1.3;   // tiles visibly fall this long before eliminating
const DONE_S = 2.2;        // hold the final board before results
const FALL_FRACTION = 0.15;   // share of standing tiles that drops on wave 1
const FALL_RAMP = 0.07;       // ...growing by this much each wave
const FALL_FRACTION_MAX = 0.6;
const HARD_CAP_FALLS = 12; // safety valve so a stalemate can never hang the room

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const trapdoor = {
  id: 'trapdoor',
  name: 'Trapdoor',
  blurb: 'Stand on a tile. Every few seconds a random set of tiles drops away — be somewhere safe. Last one standing takes the whole pot.',
  create(players) { return new TrapdoorGame(players); },
};

class TrapdoorGame {
  constructor(players) {
    this.cols = COLS; this.rows = ROWS;
    this.tiles = new Array(N).fill(1); // 1 = standing, 0 = gone, 2 = falling
    this.fallsDone = 0;
    this.finished = false;
    this.fallingSet = [];
    this.winnerId = null;
    this.tiebreak = false;   // true when the pot had to be drawn by lot
    this.players = players.map((p) => ({
      id: p.id, name: p.name, tile: this.randStandingTile(), eliminated: false, outWave: null,
    }));
    this.lastAlive = this.players.map((p) => p.id);
    this.setSub('choose', CHOOSE_S);
  }

  // Each wave takes a bigger bite and leaves less time to react, so the field
  // narrows to one player quickly no matter how many started.
  fallFraction() { return Math.min(FALL_FRACTION_MAX, FALL_FRACTION + this.fallsDone * FALL_RAMP); }
  // The floor is clamped to CHOOSE_S so that dialling the env override right
  // down for playtesting actually speeds the round up.
  chooseTime() {
    return Math.max(Math.min(CHOOSE_S, CHOOSE_MIN_S), CHOOSE_S - this.fallsDone);
  }
  standingTiles() {
    const st = [];
    for (let i = 0; i < N; i++) if (this.tiles[i] === 1) st.push(i);
    return st;
  }

  // End the round on a single winner. `ids` is the group in contention; if it
  // holds more than one they were genuinely level, so the pot is drawn by lot.
  finish(ids) {
    this.winnerId = drawFrom(ids);
    this.tiebreak = ids.length > 1;
    this.setSub('done', DONE_S);
  }

  setSub(sub, dur) { this.sub = sub; this.subLeft = dur; this.subMax = dur; }
  alive() { return this.players.filter((p) => !p.eliminated); }
  randStandingTile() {
    const st = this.standingTiles();
    return st.length ? st[Math.floor(Math.random() * st.length)] : null;
  }

  // A player picks a tile to stand on (only during 'choose', a standing tile).
  place(playerId, idx) {
    if (this.sub !== 'choose') return;
    const p = this.players.find((x) => x.id === playerId);
    idx = Math.floor(Number(idx));
    if (!p || p.eliminated || !Number.isInteger(idx) || idx < 0 || idx >= N) return;
    if (this.tiles[idx] !== 1) return;
    p.tile = idx;
  }

  update(dt) {
    if (this.finished) return true;
    this.subLeft -= dt;
    if (this.subLeft > 0) return false;
    if (this.sub === 'choose') this.startFall();
    else if (this.sub === 'falling') this.resolveFall();
    else if (this.sub === 'done') this.finished = true;
    return this.finished;
  }

  startFall() {
    const standing = this.standingTiles();
    // The board has run out from under the last few — nothing left to decide it
    // with, so they were level and the pot is drawn between them.
    if (standing.length <= 1) { this.finish(this.alive().map((p) => p.id)); return; }
    let count = Math.max(2, Math.round(standing.length * this.fallFraction()));
    count = Math.min(count, standing.length);
    this.fallingSet = shuffle(standing).slice(0, count);
    for (const i of this.fallingSet) this.tiles[i] = 2;
    this.lastAlive = this.alive().map((p) => p.id); // group going into this drop
    this.setSub('falling', FALL_ANIM_S);
  }

  resolveFall() {
    const fall = new Set(this.fallingSet);
    for (const p of this.players) {
      if (p.eliminated) continue;
      if (p.tile == null || fall.has(p.tile)) {
        p.eliminated = true; p.outWave = this.fallsDone + 1; p.tile = null;
      }
    }
    for (const i of this.fallingSet) this.tiles[i] = 0;
    this.fallingSet = [];
    this.fallsDone++;

    const alive = this.alive();
    // One left — they've won it outright. Nobody left — the wave took the whole
    // remaining group at once, so the pot is drawn between them.
    if (alive.length === 1) { this.finish([alive[0].id]); return; }
    if (alive.length === 0) { this.finish(this.lastAlive.slice()); return; }
    // Safety valve: waves keep growing, so this should never be reached, but a
    // room must never be able to hang on a stalemate.
    if (this.fallsDone >= HARD_CAP_FALLS) { this.finish(alive.map((p) => p.id)); return; }
    this.setSub('choose', this.chooseTime());
  }

  getState() {
    return {
      mode: 'tiles',
      cols: this.cols, rows: this.rows,
      tiles: this.tiles.slice(),
      sub: this.sub,
      subLeft: Math.round(Math.max(0, this.subLeft) * 100) / 100,
      subMax: this.subMax,
      fallsDone: this.fallsDone,
      players: this.players.map((p) => ({ id: p.id, name: p.name, tile: p.tile, eliminated: p.eliminated })),
    };
  }

  getResult() {
    const survived = (p) => (p.outWave != null ? p.outWave - 1 : this.fallsDone);
    const ranked = [...this.players].sort((a, b) => survived(b) - survived(a) || (a.id < b.id ? -1 : 1));
    // The winner is settled by the tile drops themselves; fall back to the
    // deepest survivor only if the round was cut short before it resolved.
    const fallback = decideWinner(ranked, survived);
    return {
      winnerId: this.winnerId ?? fallback.winnerId,
      tiebreak: this.winnerId ? this.tiebreak : fallback.tiebreak,
      scores: ranked.map((p) => ({ id: p.id, name: p.name, score: survived(p) })),
    };
  }
}

// Trapdoor: a grid of tiles. Each player stands on a tile. Every CHOOSE_S
// seconds a random set of tiles drops away — anyone standing on one is out.
// Survivors get another CHOOSE_S to stay or move, then another drop, up to
// MAX_FALLS times. Last player standing takes the pot; if several remain at the
// final drop (or everyone drops at once), they split it evenly.
//
// This minigame runs its own internal timeline via update(dt). It uses the
// 'split' payout mode (see Room.computePayouts), reporting a `winners` list.

const COLS = 7, ROWS = 5;
const N = COLS * ROWS;
const CHOOSE_S = process.env.TRAPDOOR_CHOOSE ? Number(process.env.TRAPDOOR_CHOOSE) : 10;
const FALL_ANIM_S = 1.3;   // tiles visibly fall this long before eliminating
const DONE_S = 2.2;        // hold the final board before results
const MAX_FALLS = 5;
const FALL_FRACTION = 0.15;

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
  blurb: 'Stand on a tile. Every 10 seconds a random set of tiles drops away — be somewhere safe. Last one standing takes the pot.',
  payout: 'split',
  create(players) { return new TrapdoorGame(players); },
};

class TrapdoorGame {
  constructor(players) {
    this.cols = COLS; this.rows = ROWS;
    this.tiles = new Array(N).fill(1); // 1 = standing, 0 = gone, 2 = falling
    this.fallsDone = 0;
    this.finished = false;
    this.fallingSet = [];
    this.winners = null;
    this.players = players.map((p) => ({
      id: p.id, name: p.name, tile: this.randStandingTile(), eliminated: false, outWave: null,
    }));
    this.lastAlive = this.players.map((p) => p.id);
    this.setSub('choose', CHOOSE_S);
  }

  setSub(sub, dur) { this.sub = sub; this.subLeft = dur; this.subMax = dur; }
  alive() { return this.players.filter((p) => !p.eliminated); }
  randStandingTile() {
    const st = [];
    for (let i = 0; i < N; i++) if (this.tiles[i] === 1) st.push(i);
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
    const standing = [];
    for (let i = 0; i < N; i++) if (this.tiles[i] === 1) standing.push(i);
    let count = Math.max(2, Math.round(standing.length * FALL_FRACTION));
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
    if (alive.length <= 1 || this.fallsDone >= MAX_FALLS) {
      // Winners split the pot: the lone survivor, the finalists, or — if everyone
      // dropped together — the group that went into that final drop.
      this.winners = alive.length >= 1 ? alive.map((p) => p.id) : this.lastAlive.slice();
      this.setSub('done', DONE_S);
    } else {
      this.setSub('choose', CHOOSE_S);
    }
  }

  getState() {
    return {
      mode: 'tiles',
      cols: this.cols, rows: this.rows,
      tiles: this.tiles.slice(),
      sub: this.sub,
      subLeft: Math.round(Math.max(0, this.subLeft) * 100) / 100,
      subMax: this.subMax,
      fallsDone: this.fallsDone, maxFalls: MAX_FALLS,
      players: this.players.map((p) => ({ id: p.id, name: p.name, tile: p.tile, eliminated: p.eliminated })),
    };
  }

  getResult() {
    const ws = this.winners && this.winners.length ? this.winners : this.alive().map((p) => p.id);
    const survived = (p) => (p.outWave != null ? p.outWave - 1 : this.fallsDone);
    const ranked = [...this.players].sort((a, b) => survived(b) - survived(a) || (a.id < b.id ? -1 : 1));
    return {
      winnerId: ws[0] ?? ranked[0]?.id ?? null,
      winners: ws,
      scores: ranked.map((p) => ({ id: p.id, name: p.name, score: survived(p) })),
    };
  }
}

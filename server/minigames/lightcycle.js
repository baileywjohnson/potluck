// Lightcycles: a competitive Tron. Each rider moves at a constant speed on a
// grid, leaving a solid trail. Run into ANY trail (yours or a rival's) or the
// wall and you crash out. The last rider standing takes the whole pot.
// Fully server-authoritative (grid stepping + a trail grid for collisions).
//
// There's no meaningful time limit: every step lays down a cell, so the board
// fills and someone must crash — the round always resolves itself. The duration
// below is only a safety valve. Riders who crash head-on into each other on the
// same step are genuinely level, so the pot is drawn by lot between them rather
// than split (see ./tiebreak.js).

import { decideWinner, drawFrom } from './tiebreak.js';

const COLS = 56, ROWS = 34;
const STEPS_PER_SEC = 14;        // grid cells crossed per second
// Safety valve only. The board is 56x34 and a cell is consumed per rider per
// step, so two riders exhaust it in about 68s and the round ends on its own well
// before this — it exists so a room can never hang.
const DURATION_S = process.env.LIGHTCYCLE_DURATION ? Number(process.env.LIGHTCYCLE_DURATION) : 90;

export const lightcycle = {
  id: 'lightcycle',
  name: 'Lightcycles',
  blurb: 'Leave a wall of light and box your rivals in. Crash into any trail or the wall and you are out — last rider standing takes the whole pot.',
  create(players) { return new LightcycleGame(players); },
};

class LightcycleGame {
  constructor(players) {
    this.cols = COLS; this.rows = ROWS;
    this.grid = new Uint8Array(COLS * ROWS); // 1 = trail/occupied
    this.acc = 0; this.progress = 0;
    this.elapsed = 0; this.timeLeft = DURATION_S;
    this.finished = false;
    this.newTrail = []; // cells laid since the last getState (for the client)
    this.winnerId = null;
    this.tiebreak = false;  // true when the pot had to be drawn by lot

    // Spawn riders along the two sides, facing inward (classic Tron start).
    const n = players.length, perSide = Math.ceil(n / 2);
    this.cycles = players.map((p, i) => {
      const side = i % 2, slot = Math.floor(i / 2);
      const x = side === 0 ? 5 : COLS - 6;
      const y = Math.round((ROWS * (slot + 1)) / (perSide + 1));
      const dir = side === 0 ? { x: 1, y: 0 } : { x: -1, y: 0 };
      return { id: p.id, name: p.name, x, y, dir, pendingDir: dir, alive: true, outAt: null };
    });
    this.lastAlive = this.cycles.map((c) => c.id);
  }

  idx(x, y) { return y * COLS + x; }
  inBounds(x, y) { return x >= 0 && x < COLS && y >= 0 && y < ROWS; }

  // Queue a turn (applied on the next step). 4-way only; can't reverse.
  turn(playerId, d) {
    const c = this.cycles.find((x) => x.id === playerId);
    if (!c || !c.alive || !d) return;
    const dx = Math.sign(d.x || 0), dy = Math.sign(d.y || 0);
    if ((dx !== 0) === (dy !== 0)) return;            // must be exactly one axis
    if (dx === -c.dir.x && dy === -c.dir.y) return;   // no 180° reversals
    c.pendingDir = { x: dx, y: dy };
  }

  update(dt) {
    if (this.finished) return true;
    this.elapsed += dt;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    this.acc += dt;
    const STEP = 1 / STEPS_PER_SEC;
    while (this.acc >= STEP && !this.finished) { this.acc -= STEP; this.stepAll(); }
    this.progress = this.finished ? 0 : Math.min(1, this.acc / STEP);
    if (this.timeLeft <= 0 && !this.finished) this.endNow();
    return this.finished;
  }

  // One simultaneous step for every rider (order-independent).
  stepAll() {
    const alive = this.cycles.filter((c) => c.alive);
    this.lastAlive = alive.map((c) => c.id);

    // Phase A: apply turns, lay trail at the current cell, compute the next cell.
    for (const c of alive) {
      if (!(c.pendingDir.x === -c.dir.x && c.pendingDir.y === -c.dir.y)) c.dir = c.pendingDir;
      this.grid[this.idx(c.x, c.y)] = 1;
      this.newTrail.push({ x: c.x, y: c.y, id: c.id });
      c.nx = c.x + c.dir.x; c.ny = c.y + c.dir.y;
    }
    // Phase B: a rider dies if its next cell is a wall, a trail, or shared with
    // another rider this step (head-on / same-cell).
    const nextCount = {};
    for (const c of alive) if (this.inBounds(c.nx, c.ny)) {
      const k = this.idx(c.nx, c.ny); nextCount[k] = (nextCount[k] || 0) + 1;
    }
    for (const c of alive) {
      const ob = !this.inBounds(c.nx, c.ny);
      if (ob || this.grid[this.idx(c.nx, c.ny)] === 1 || nextCount[this.idx(c.nx, c.ny)] > 1) {
        c.alive = false; c.outAt = this.elapsed;
      }
    }
    for (const c of alive) if (c.alive) { c.x = c.nx; c.y = c.ny; }

    if (this.cycles.filter((c) => c.alive).length <= 1) this.endNow();
  }

  endNow() {
    if (this.finished) return;
    const alive = this.cycles.filter((c) => c.alive);
    // One rider left is the clean ending. Nobody left means the survivors took
    // each other out on the same step, and more than one left means the safety
    // cap fired — either way the group is level, so the pot is drawn between
    // them rather than split.
    const contenders = alive.length >= 1 ? alive.map((c) => c.id) : this.lastAlive.slice();
    this.winnerId = drawFrom(contenders);
    this.tiebreak = contenders.length > 1;
    this.finished = true;
  }

  getState() {
    const nt = this.newTrail; this.newTrail = [];
    return {
      mode: 'tron', cols: COLS, rows: ROWS,
      timeLeft: Math.ceil(this.timeLeft),
      progress: Math.round(this.progress * 100) / 100,
      newTrail: nt,
      cycles: this.cycles.map((c) => ({ id: c.id, name: c.name, x: c.x, y: c.y, dir: c.dir, alive: c.alive })),
    };
  }

  getResult() {
    const survived = (c) => (c.outAt != null ? c.outAt : this.elapsed);
    const ranked = [...this.cycles].sort((a, b) => survived(b) - survived(a) || (a.id < b.id ? -1 : 1));
    // The crashes settle it; fall back to whoever lasted longest only if the
    // round was cut short before it resolved.
    const fallback = decideWinner(ranked, survived);
    return {
      winnerId: this.winnerId ?? fallback.winnerId,
      tiebreak: this.winnerId ? this.tiebreak : fallback.tiebreak,
      scores: ranked.map((c) => ({ id: c.id, name: c.name, score: Math.round(survived(c)) })),
    };
  }
}

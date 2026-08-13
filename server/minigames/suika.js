// Fruit Drop (competitive Suika): each player drops fruit into their own jar.
// Two fruits of the same kind that touch merge into the next size up and score.
// Highest score when the timer runs out wins; if your pile overflows the top
// line, your jar freezes (you're out). Fully server-authoritative — a compact
// circle physics sim (gravity + positional collision solver + merging).

import { decideWinner } from './tiebreak.js';

// Harder: a narrower jar with a lower danger line (less room), a less forgiving
// top-out grace, and bigger/more varied fruit to drop.
const W = 210, H = 320;          // jar interior (logical units) — narrower than before
const DROP_Y = 26;               // where the held fruit hovers / spawns
const DANGER_Y = 100;            // a settled pile above this line tops the jar out (lower = less room)
const GRAVITY = 1600;            // px/s^2
const MAX_V = 1900;              // velocity cap (stability)
const REST = 0.12;               // restitution — low so fruit settles, doesn't bounce
const ITER = 6;                  // collision solver iterations per tick
const DROP_COOLDOWN = 0.45;      // seconds between drops
const TOPOUT_GRACE = 1.6;        // seconds a pile can sit over the line before you're out
const DURATION_S = process.env.SUIKA_DURATION ? Number(process.env.SUIKA_DURATION) : 60;

const RADII = [12, 16, 21, 27, 34, 42, 51, 61, 73]; // fruit sizes by type
const MAX_TYPE = RADII.length - 1;
const points = (newType) => (newType + 1) * (newType + 1); // value of a merge

// Bigger, more varied drops than before: mostly small, but plenty of mediums
// and the occasional large one to fill the jar faster.
const randDrop = () => {
  const r = Math.random();
  return r < 0.4 ? 0 : r < 0.7 ? 1 : r < 0.9 ? 2 : 3;
};

export const suika = {
  id: 'suika',
  name: 'Fruit Drop',
  blurb: 'Drop fruit into your jar — matching fruits merge into bigger ones. Most points takes the whole pot; overflow the top and you are out.',
  create(players) { return new SuikaGame(players); },
};

class SuikaGame {
  constructor(players) {
    this.timeLeft = DURATION_S;
    this.elapsed = 0;
    this.finished = false;
    this.boards = players.map((p) => ({
      id: p.id, name: p.name,
      fruits: [],
      seq: 0,            // fruit id counter
      score: 0,
      aimX: W / 2,
      current: randDrop(),
      next: randDrop(),
      dropCd: 0,
      overTime: 0,       // how long the pile has sat over the danger line
      toppedOut: false,
    }));
  }

  board(id) { return this.boards.find((b) => b.id === id); }

  // Move the held fruit left/right (absolute board x).
  aim(playerId, x) {
    const b = this.board(playerId);
    if (!b || b.toppedOut) return;
    const r = RADII[b.current];
    b.aimX = Math.max(r, Math.min(W - r, Number(x) || 0));
  }

  // Drop the held fruit (if off cooldown).
  drop(playerId) {
    const b = this.board(playerId);
    if (!b || b.toppedOut || b.dropCd > 0) return;
    const r = RADII[b.current];
    b.fruits.push({
      id: b.seq++, x: Math.max(r, Math.min(W - r, b.aimX)),
      y: DROP_Y, vx: 0, vy: 0, type: b.current, age: 0,
    });
    b.current = b.next;
    b.next = randDrop();
    b.dropCd = DROP_COOLDOWN;
  }

  update(dt) {
    if (this.finished) return true;
    this.elapsed += dt;
    this.timeLeft = Math.max(0, this.timeLeft - dt);

    for (const b of this.boards) {
      if (b.toppedOut) continue;
      b.dropCd = Math.max(0, b.dropCd - dt);

      for (const f of b.fruits) {
        f.age += dt;
        f.vy += GRAVITY * dt;
        const sp = Math.hypot(f.vx, f.vy);
        if (sp > MAX_V) { f.vx *= MAX_V / sp; f.vy *= MAX_V / sp; }
        f.x += f.vx * dt; f.y += f.vy * dt;
      }
      this.mergePass(b);
      for (let k = 0; k < ITER; k++) this.solve(b);
      this.checkTopOut(b, dt);
    }

    if (this.timeLeft <= 0 || this.boards.every((b) => b.toppedOut)) this.finished = true;
    return this.finished;
  }

  // Merge overlapping same-type fruit into the next size up.
  mergePass(b) {
    const f = b.fruits;
    const merged = new Set();
    const add = [];
    for (let i = 0; i < f.length; i++) {
      if (merged.has(i)) continue;
      for (let j = i + 1; j < f.length; j++) {
        if (merged.has(j) || f[i].type !== f[j].type) continue;
        const dx = f[j].x - f[i].x, dy = f[j].y - f[i].y;
        const d = Math.hypot(dx, dy);
        if (d >= RADII[f[i].type] + RADII[f[j].type]) continue;
        merged.add(i); merged.add(j);
        const t = f[i].type;
        if (t < MAX_TYPE) {
          add.push({
            id: b.seq++, type: t + 1, age: 0,
            x: (f[i].x + f[j].x) / 2, y: (f[i].y + f[j].y) / 2,
            vx: (f[i].vx + f[j].vx) / 2, vy: (f[i].vy + f[j].vy) / 2,
          });
          b.score += points(t + 1);
        } else {
          b.score += 120; // two of the biggest fruit pop for a bonus
        }
        break;
      }
    }
    if (merged.size) b.fruits = f.filter((_, i) => !merged.has(i)).concat(add);
  }

  // One iteration of wall + pairwise separation.
  solve(b) {
    const f = b.fruits;
    for (const a of f) {
      const r = RADII[a.type];
      if (a.x < r) { a.x = r; if (a.vx < 0) a.vx = -a.vx * REST; }
      if (a.x > W - r) { a.x = W - r; if (a.vx > 0) a.vx = -a.vx * REST; }
      if (a.y > H - r) { a.y = H - r; if (a.vy > 0) a.vy = -a.vy * REST; a.vx *= 0.9; }
      if (a.y < -r) a.y = -r;
    }
    for (let i = 0; i < f.length; i++) {
      for (let j = i + 1; j < f.length; j++) {
        const minD = RADII[f[i].type] + RADII[f[j].type];
        let dx = f[j].x - f[i].x, dy = f[j].y - f[i].y;
        let d = Math.hypot(dx, dy);
        if (d >= minD) continue;
        if (d < 0.001) { dx = (i % 2 ? 0.1 : -0.1); dy = -1; d = 1; } // nudge apart
        const nx = dx / d, ny = dy / d, push = (minD - d) / 2;
        f[i].x -= nx * push; f[i].y -= ny * push;
        f[j].x += nx * push; f[j].y += ny * push;
        const vn = (f[j].vx - f[i].vx) * nx + (f[j].vy - f[i].vy) * ny;
        if (vn < 0) {
          const imp = -(1 + REST) * vn / 2;
          f[i].vx -= imp * nx; f[i].vy -= imp * ny;
          f[j].vx += imp * nx; f[j].vy += imp * ny;
        }
      }
    }
  }

  // A jar tops out if a settled fruit's top stays above the danger line.
  checkTopOut(b, dt) {
    let over = false;
    for (const a of b.fruits) {
      if (a.age > 0.6 && a.y - RADII[a.type] < DANGER_Y && Math.abs(a.vy) < 60) { over = true; break; }
    }
    b.overTime = over ? b.overTime + dt : Math.max(0, b.overTime - dt * 2);
    if (b.overTime >= TOPOUT_GRACE) b.toppedOut = true;
  }

  getState() {
    return {
      mode: 'suika',
      board: { w: W, h: H, dropY: DROP_Y, dangerY: DANGER_Y },
      radii: RADII,
      timeLeft: Math.ceil(this.timeLeft),
      players: this.boards.map((b) => ({
        id: b.id, name: b.name, score: b.score, toppedOut: b.toppedOut,
        aimX: Math.round(b.aimX), current: b.current, next: b.next, dropReady: b.dropCd <= 0,
        fruits: b.fruits.map((f) => ({ id: f.id, x: Math.round(f.x), y: Math.round(f.y), type: f.type })),
      })),
    };
  }

  getResult() {
    // Topping out means you're OUT — you can't win the pot no matter how many
    // points you banked before overflowing. Survivors rank above topped-out
    // jars; within each group it's highest score. (If *everyone* topped out the
    // pot still has to go somewhere, so the best of them takes it.)
    const ranked = [...this.boards].sort((a, b) =>
      (a.toppedOut ? 1 : 0) - (b.toppedOut ? 1 : 0)
      || b.score - a.score
      || (a.id < b.id ? -1 : 1));
    // A dead heat on score (within the same in/out group) is drawn by lot.
    const { winnerId, tiebreak } = decideWinner(ranked, (b) => `${b.toppedOut ? 'out' : 'in'}:${b.score}`);
    return {
      winnerId,
      tiebreak,
      scores: ranked.map((b) => ({ id: b.id, name: b.name, score: b.score })),
    };
  }
}

// Coin Rush: players steer a circle around an arena and collect coins.
// Most coin value when the timer expires wins. Fully server-authoritative:
// clients only send a desired movement direction; the server simulates.
//
// This file is the reference implementation of the Minigame interface that
// Room expects. To add a new minigame, export the same shape from a new
// file and register it in ./index.js.

import { decideWinner } from './tiebreak.js';

const ARENA = { width: 900, height: 560 };
const PLAYER_RADIUS = 18;
const COIN_RADIUS = 11;
const SPEED = 260;            // px/sec max movement speed
const BOOST_SPEED = 880;      // px/sec while lunging (Space)
const BOOST_DURATION_S = 0.22; // how long a lunge lasts
const BOOST_COOLDOWN_S = 5;   // wait between lunges
const BULLET_SPEED = 620;     // px/sec for a shot (left click)
const BULLET_RADIUS = 5;
const BULLET_LIFE_S = 1.6;    // shot fizzles after this long
const SHOOT_COOLDOWN_S = 0.4; // min time between shots
const SLOW_FACTOR = 0.5;      // a hit player moves at half speed
const SLOW_DURATION_S = 1.5;  // for this long after being hit
// Round length. Overridable via env for fast integration tests.
const DURATION_S = process.env.COIN_RUSH_DURATION
  ? Number(process.env.COIN_RUSH_DURATION) : 20;
const COIN_COUNT = 10;        // coins present at once
const COIN_VALUE = 1;

function randPos() {
  const pad = 30;
  return {
    x: pad + Math.random() * (ARENA.width - pad * 2),
    y: pad + Math.random() * (ARENA.height - pad * 2),
  };
}

export const coinRush = {
  id: 'coinRush',
  name: 'Coin Rush',
  // Shown to players during betting so they know what they're wagering on.
  blurb: 'Grab coins for 20 seconds. Move with WASD / arrows, press Space to lunge. Most coins takes the whole pot.',

  create(players) {
    return new CoinRushGame(players);
  },
};

class CoinRushGame {
  constructor(players) {
    this.timeLeft = DURATION_S;
    this.finished = false;

    // Spread starting positions so nobody overlaps a corner advantage.
    this.players = players.map((p, i) => {
      const angle = (i / players.length) * Math.PI * 2;
      return {
        id: p.id,
        name: p.name,
        x: ARENA.width / 2 + Math.cos(angle) * 140,
        y: ARENA.height / 2 + Math.sin(angle) * 100,
        dir: { x: 0, y: 0 },       // desired movement, set by input
        facing: { x: 0, y: 0 },    // last non-zero heading (for lunging while still)
        boostDir: { x: 0, y: 0 },  // locked-in lunge direction
        boostLeft: 0,              // seconds of lunge remaining
        boostCd: 0,                // seconds until the next lunge is ready
        shootCd: 0,                // seconds until you can shoot again
        slowLeft: 0,               // seconds of being slowed (after a hit)
        score: 0,
      };
    });

    this.coins = [];
    for (let i = 0; i < COIN_COUNT; i++) {
      this.coins.push({ id: i, ...randPos() });
    }

    this.projectiles = [];   // active shots
    this.nextBulletId = 0;
  }

  // input: { x, y } desired direction (need not be normalized).
  handleInput(playerId, input) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player || !input) return;
    let { x = 0, y = 0 } = input;
    const mag = Math.hypot(x, y);
    if (mag > 1) { x /= mag; y /= mag; } // clamp to unit length
    player.dir = { x, y };
    if (mag > 0.01) player.facing = { x: x / mag, y: y / mag }; // remember heading
  }

  // Space pressed: lunge forward if off cooldown. Lunges in the current heading
  // (or last heading if standing still); a no-direction press is ignored.
  boost(playerId) {
    const p = this.players.find((x) => x.id === playerId);
    if (!p || p.boostCd > 0 || p.boostLeft > 0) return;
    const d = Math.hypot(p.dir.x, p.dir.y) > 0.01 ? p.dir : p.facing;
    const m = Math.hypot(d.x, d.y);
    if (m < 0.01) return; // no direction to lunge in
    p.boostDir = { x: d.x / m, y: d.y / m };
    p.boostLeft = BOOST_DURATION_S;
    p.boostCd = BOOST_COOLDOWN_S;
  }

  // Left click: fire a shot from the player toward an aim point. A hit slows
  // the struck player. Rate-limited by SHOOT_COOLDOWN.
  shoot(playerId, target) {
    const p = this.players.find((x) => x.id === playerId);
    if (!p || p.shootCd > 0 || !target) return;
    const dx = target.x - p.x, dy = target.y - p.y;
    const m = Math.hypot(dx, dy);
    if (m < 1) return; // aimed at yourself
    this.projectiles.push({
      id: this.nextBulletId++, ownerId: p.id,
      x: p.x, y: p.y, vx: (dx / m) * BULLET_SPEED, vy: (dy / m) * BULLET_SPEED,
      life: BULLET_LIFE_S,
    });
    p.shootCd = SHOOT_COOLDOWN_S;
  }

  // dt in seconds. Returns true when the minigame is over.
  update(dt) {
    if (this.finished) return true;

    for (const p of this.players) {
      p.boostCd = Math.max(0, p.boostCd - dt);
      p.shootCd = Math.max(0, p.shootCd - dt);
      p.slowLeft = Math.max(0, p.slowLeft - dt);

      // Lunge overrides normal steering for its short duration; being hit halves speed.
      let dir = p.dir, speed = SPEED;
      if (p.boostLeft > 0) {
        dir = p.boostDir; speed = BOOST_SPEED;
        p.boostLeft = Math.max(0, p.boostLeft - dt);
      }
      if (p.slowLeft > 0) speed *= SLOW_FACTOR;
      p.x += dir.x * speed * dt;
      p.y += dir.y * speed * dt;
      // Keep avatars inside the arena.
      p.x = Math.max(PLAYER_RADIUS, Math.min(ARENA.width - PLAYER_RADIUS, p.x));
      p.y = Math.max(PLAYER_RADIUS, Math.min(ARENA.height - PLAYER_RADIUS, p.y));

      // Collect any coins within reach; respawn them elsewhere.
      const hitDist = PLAYER_RADIUS + COIN_RADIUS;
      for (const coin of this.coins) {
        if (Math.hypot(p.x - coin.x, p.y - coin.y) < hitDist) {
          p.score += COIN_VALUE;
          Object.assign(coin, randPos());
        }
      }
    }

    // Advance shots; a hit slows the struck player (but not the shooter).
    for (const b of this.projectiles) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      for (const p of this.players) {
        if (p.id === b.ownerId) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < PLAYER_RADIUS + BULLET_RADIUS) {
          p.slowLeft = SLOW_DURATION_S;
          b.life = 0; // consumed
          break;
        }
      }
    }
    this.projectiles = this.projectiles.filter((b) =>
      b.life > 0 && b.x > -20 && b.x < ARENA.width + 20 && b.y > -20 && b.y < ARENA.height + 20
    );

    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.timeLeft <= 0) this.finished = true;
    return this.finished;
  }

  // Public state broadcast to clients each tick.
  getState() {
    return {
      arena: ARENA,
      timeLeft: Math.ceil(this.timeLeft),
      boostMax: BOOST_COOLDOWN_S,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), score: p.score,
        boostCd: Math.round(p.boostCd * 10) / 10, // seconds until ready (0 = ready)
        boosting: p.boostLeft > 0,
        slowed: p.slowLeft > 0,
      })),
      coins: this.coins.map((c) => ({ id: c.id, x: Math.round(c.x), y: Math.round(c.y) })),
      projectiles: this.projectiles.map((b) => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y) })),
    };
  }

  // Final outcome. Most coins takes the whole pot; a dead heat on coins is
  // drawn by lot rather than handed to whoever sorts first.
  getResult() {
    const ranked = [...this.players].sort(
      (a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)
    );
    const { winnerId, tiebreak } = decideWinner(ranked, (p) => p.score);
    return {
      winnerId,
      tiebreak,
      scores: ranked.map((p) => ({ id: p.id, name: p.name, score: p.score })),
    };
  }
}

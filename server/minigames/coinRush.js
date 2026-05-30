// Coin Rush: players steer a circle around an arena and collect coins.
// Most coin value when the timer expires wins. Fully server-authoritative:
// clients only send a desired movement direction; the server simulates.
//
// This file is the reference implementation of the Minigame interface that
// Room expects. To add a new minigame, export the same shape from a new
// file and register it in ./index.js.

const ARENA = { width: 900, height: 560 };
const PLAYER_RADIUS = 18;
const COIN_RADIUS = 11;
const SPEED = 260;            // px/sec max movement speed
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
  blurb: 'Grab coins for 20 seconds. Use WASD or arrow keys to move.',
  // 'proportional' = the pot is split by score (coins), so everyone who grabs
  // coins wins a share. (Default for a minigame is 'winner' — winner takes all.)
  payout: 'proportional',

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
        dir: { x: 0, y: 0 }, // desired movement, set by input
        score: 0,
      };
    });

    this.coins = [];
    for (let i = 0; i < COIN_COUNT; i++) {
      this.coins.push({ id: i, ...randPos() });
    }
  }

  // input: { x, y } desired direction (need not be normalized).
  handleInput(playerId, input) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player || !input) return;
    let { x = 0, y = 0 } = input;
    const mag = Math.hypot(x, y);
    if (mag > 1) { x /= mag; y /= mag; } // clamp to unit length
    player.dir = { x, y };
  }

  // dt in seconds. Returns true when the minigame is over.
  update(dt) {
    if (this.finished) return true;

    for (const p of this.players) {
      p.x += p.dir.x * SPEED * dt;
      p.y += p.dir.y * SPEED * dt;
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

    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.timeLeft <= 0) this.finished = true;
    return this.finished;
  }

  // Public state broadcast to clients each tick.
  getState() {
    return {
      arena: ARENA,
      timeLeft: Math.ceil(this.timeLeft),
      players: this.players.map((p) => ({
        id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), score: p.score,
      })),
      coins: this.coins.map((c) => ({ id: c.id, x: Math.round(c.x), y: Math.round(c.y) })),
    };
  }

  // Final outcome. Highest score wins; ties broken by lowest id (stable).
  getResult() {
    const ranked = [...this.players].sort(
      (a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)
    );
    return {
      winnerId: ranked[0]?.id ?? null,
      scores: ranked.map((p) => ({ id: p.id, name: p.name, score: p.score })),
    };
  }
}

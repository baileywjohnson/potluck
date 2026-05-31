// Central tunables for the game. Tweak these to change pacing/economy.
// Any value can be overridden with an env var of the same name, which is
// handy for tuning and for fast integration tests (e.g. BETTING_MS=2000).
const num = (key, fallback) =>
  process.env[key] !== undefined ? Number(process.env[key]) : fallback;

export const CONFIG = {
  // A player's persistent wallet, kept between matches. New players start here.
  STARTING_BANKROLL: num('STARTING_BANKROLL', 1000),

  // Low-stakes mode: the free even stake the house gives everyone at the start
  // of each match (you must make it last; no top-ups between minigames).
  LOW_STAKES_STIPEND: num('LOW_STAKES_STIPEND', 50),

  // High-stakes mode: default buy-in the host can adjust. Each player pays it
  // from their bankroll to take a seat, and busting to 0 eliminates them.
  DEFAULT_BUYIN: num('DEFAULT_BUYIN', 500),

  TOTAL_ROUNDS: num('TOTAL_ROUNDS', 5),        // how many minigames make up a match
  MIN_PLAYERS: num('MIN_PLAYERS', 2),          // participants needed to start a match

  // Experience earned per minigame (persistent, drives player level).
  XP_BASE: num('XP_BASE', 15),                 // for playing a minigame
  XP_WIN: num('XP_WIN', 25),                   // bonus for winning it
  XP_PER_SCORE: num('XP_PER_SCORE', 1),        // per point scored (e.g. coin), capped
  XP_SCORE_CAP: num('XP_SCORE_CAP', 40),       // max score-based XP per minigame

  // Poker-style betting (fixed-limit). Each minigame is preceded by one betting
  // round: everyone antes, then bets/raises in fixed increments, winner of the
  // minigame takes the pot. Ante and bet are fractions of a player's starting
  // match stake so they scale between low- and high-stakes.
  ANTE_FRACTION: num('ANTE_FRACTION', 0.1),    // ante = 10% of the starting stake
  BET_FRACTION: num('BET_FRACTION', 0.2),      // bet/raise increment = 20% of the stake
  MAX_BETS: num('MAX_BETS', 4),                // opening bet + up to 3 raises per round
  TURN_MS: num('TURN_MS', 15000),              // per-turn timer; auto-check or auto-fold

  // Phase durations in milliseconds.
  COUNTDOWN_MS: num('COUNTDOWN_MS', 3000),     // "3..2..1" before the minigame begins
  RESULTS_MS: num('RESULTS_MS', 8000),         // time spent showing the pot result

  // How long a disconnected player's seat (chips, bets, host) is held open
  // for them to rejoin before it is permanently freed.
  RECONNECT_GRACE_MS: num('RECONNECT_GRACE_MS', 60000),

  // Server simulation. Clients interpolate between snapshots, so this is the
  // network/sim rate, not the on-screen frame rate (which is the display's).
  TICK_HZ: num('TICK_HZ', 30),                 // authoritative simulation + broadcast rate
};

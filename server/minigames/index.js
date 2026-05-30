// Minigame registry. Add new minigames here and the rotation will pick
// them up. Each entry must expose: { id, name, blurb, create(players) }.
import { coinRush } from './coinRush.js';

export const MINIGAMES = [coinRush];

// Pick the minigame for a given round. For the vertical slice we cycle
// through the registry; with one game that's always Coin Rush.
export function minigameForRound(roundIndex) {
  return MINIGAMES[roundIndex % MINIGAMES.length];
}

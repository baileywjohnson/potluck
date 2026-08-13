// Minigame registry. Add new minigames here and the rotation will pick
// them up. Each entry must expose: { id, name, blurb, create(players) }.
// Every minigame is winner-take-all — the pot is never divided.
import { coinRush } from './coinRush.js';
import { typeRace } from './typeRace.js';
import { suika } from './suika.js';
import { trapdoor } from './trapdoor.js';
import { lightcycle } from './lightcycle.js';

export const MINIGAMES = [coinRush, typeRace, suika, trapdoor, lightcycle];

// Pick the minigame for a given round — cycles through the registry.
export function minigameForRound(roundIndex) {
  return MINIGAMES[roundIndex % MINIGAMES.length];
}

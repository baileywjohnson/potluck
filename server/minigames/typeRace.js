// Type Race: everyone races to type the same paragraph correctly. A player's
// progress is the length of their correctly-typed prefix (so a mistake stalls
// you until you fix it). Each player's slug advances with their progress; the
// first to reach the end wins. Fully server-authoritative — clients send their
// typed text and the server decides progress.
//
// Paragraphs are ~250 characters, so a 100 WPM typist (~500 chars/min) finishes
// in about 30 seconds.

import { decideWinner } from './tiebreak.js';

const PARAGRAPHS = [
  "The old lighthouse stood at the edge of the cliff, its faded paint peeling in the salty wind. Each evening the keeper climbed the spiral stairs to light the great lamp, watching the waves crash far below as weary ships drifted toward the calm harbor.",
  "Deep in the quiet forest a narrow path wound between tall pines and mossy stones. Sunlight slipped through the branches in soft golden streaks, and the only sound was the gentle rush of a hidden stream tumbling over rocks on its long journey to the sea.",
  "She packed her worn leather bag with a folded map, a small compass, and a fresh loaf of bread, then stepped out into the cool morning air. The road ahead was long and uncertain, but her heart felt light, for adventure had always been the thing she loved.",
  "In the busy market square the vendors called out their prices while children darted between the stalls. The smell of warm bread and ripe fruit filled the air, and a street musician played a cheerful tune that made nearly everyone smile as they wandered by.",
];

// Time cap. The race ends as soon as someone finishes (or this runs out).
const DURATION_S = process.env.TYPE_RACE_DURATION
  ? Number(process.env.TYPE_RACE_DURATION) : 60;

function matchLen(typed, target) {
  let i = 0;
  const n = Math.min(typed.length, target.length);
  while (i < n && typed[i] === target[i]) i++;
  return i;
}

export const typeRace = {
  id: 'typeRace',
  name: 'Type Race',
  blurb: 'Type the paragraph correctly — first slug to the finish line takes the whole pot. Mistakes stall you until you fix them.',

  create(players) {
    return new TypeRaceGame(players);
  },
};

class TypeRaceGame {
  constructor(players) {
    this.paragraph = PARAGRAPHS[Math.floor(Math.random() * PARAGRAPHS.length)];
    this.len = this.paragraph.length;
    this.timeLeft = DURATION_S;
    this.elapsed = 0;
    this.finished = false;

    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      progress: 0,        // furthest correct-prefix length reached
      finishTime: null,   // elapsed seconds when they completed the paragraph
    }));
  }

  // A player submits their current typed buffer; we score the correct prefix.
  handleType(playerId, text) {
    const p = this.players.find((x) => x.id === playerId);
    if (!p || p.finishTime != null || typeof text !== 'string') return;
    const correct = matchLen(text.slice(0, this.len), this.paragraph);
    if (correct > p.progress) p.progress = correct; // progress only moves forward
    if (p.progress >= this.len) p.finishTime = this.elapsed;
  }

  // No physics — just advance the clock and end on the first finisher (or time).
  update(dt) {
    if (this.finished) return true;
    this.elapsed += dt;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    const anyFinished = this.players.some((p) => p.finishTime != null);
    if (this.timeLeft <= 0 || anyFinished) this.finished = true;
    return this.finished;
  }

  wpm(p) {
    const t = p.finishTime != null ? p.finishTime : this.elapsed;
    if (t <= 0) return 0;
    return Math.round((p.progress / 5) / (t / 60)); // a "word" is 5 characters
  }

  getState() {
    return {
      mode: 'typing',
      paragraph: this.paragraph,
      finishLine: this.len,
      timeLeft: Math.ceil(this.timeLeft),
      players: this.players.map((p) => ({
        id: p.id, name: p.name, progress: p.progress,
        finished: p.finishTime != null, wpm: this.wpm(p),
      })),
    };
  }

  // Finishers first (earliest wins); then by how far everyone else got. If the
  // clock runs out with nobody home and the leaders are level on characters,
  // the pot is drawn by lot between them.
  getResult() {
    const ranked = [...this.players].sort((a, b) => {
      const af = a.finishTime != null, bf = b.finishTime != null;
      if (af && bf) return a.finishTime - b.finishTime;
      if (af !== bf) return af ? -1 : 1;
      return b.progress - a.progress || (a.id < b.id ? -1 : 1);
    });
    const { winnerId, tiebreak } = decideWinner(ranked, (p) =>
      p.finishTime != null ? `done:${p.finishTime}` : `at:${p.progress}`);
    return {
      winnerId,
      tiebreak,
      scores: ranked.map((p) => ({ id: p.id, name: p.name, score: this.wpm(p) })),
    };
  }
}

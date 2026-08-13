// Exactly one player ever takes the pot — Potluck never splits it.
//
// Most minigames produce a clear winner on their own, but some can end with
// players genuinely level: two riders crashing head-on into each other on the
// same step, the last survivors on a board that ran out of tiles, two jars on an
// identical score. Rather than dividing the pot, the winner is then drawn by lot
// from the tied group, and `tiebreak` is set so the results screen can say the
// pot was decided on a coin flip instead of silently picking someone.

// Draw a winner from `candidates`, which must already be sorted best-first.
// `rank` returns a comparable key — anything that `===` compares correctly, so
// composite orderings can be expressed as a string (e.g. `out:${score}`).
export function decideWinner(candidates, rank) {
  if (!candidates.length) return { winnerId: null, tiebreak: false };
  const best = rank(candidates[0]);
  const tied = candidates.filter((c) => rank(c) === best);
  return { winnerId: drawFrom(tied.map((c) => c.id)), tiebreak: tied.length > 1 };
}

// The same draw over a plain list of ids — used when a wipe leaves nobody
// standing and the pot goes to one of the group that went into it.
export function drawFrom(ids) {
  return ids.length ? ids[Math.floor(Math.random() * ids.length)] : null;
}

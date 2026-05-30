/* global io */
const socket = io();

// ---- local client state ----------------------------------------------------
const me = { id: null, code: null };
let state = null;          // latest authoritative room snapshot
let lastTick = null;       // latest minigame frame during PLAYING

// Felt table: keep seat/bet-chip elements keyed by player id so they update in
// place (smooth transitions) instead of being rebuilt every frame.
const seatEls = new Map();
const betEls = new Map();
const prevAction = new Map(); // id -> last action seen, to pop the badge on change

// Side bets.
const sideRowEls = new Map();    // pid -> side-bet list row element
const seenIncoming = new Set();  // challenge ids we've already toasted
let selectedSideTarget = null;   // who I'm about to challenge

const $ = (id) => document.getElementById(id);

// ---- session persistence (for reconnect / reload) --------------------------
// We remember the room code + secret token so the same seat can be reclaimed
// after a network drop or a full page refresh. We use sessionStorage (not
// localStorage) so it's scoped to THIS tab/window — that lets you open several
// windows on one machine as different players without their sessions colliding.
const SESSION_KEY = 'gambleparty.session';
const store = window.sessionStorage;
let session = loadSession();
let hasLeft = false; // true after an explicit Leave, so stale states are ignored

function loadSession() {
  try { return JSON.parse(store.getItem(SESSION_KEY)) || null; }
  catch { return null; }
}
function saveSession(s) {
  session = s;
  hasLeft = false;
  me.id = s.playerId; me.code = s.code;
  try { store.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
}
function clearSession() {
  session = null;
  me.id = null; me.code = null;
  try { store.removeItem(SESSION_KEY); } catch {}
}
const PALETTE = ['#ffcd3c', '#4ade80', '#60a5fa', '#f472b6', '#fb923c', '#a78bfa', '#22d3ee', '#f87171'];
const colorFor = (id) => {
  const idx = (state?.players || []).findIndex((p) => p.id === id);
  return PALETTE[(idx + PALETTE.length) % PALETTE.length];
};

// ---- screen routing --------------------------------------------------------
function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
}

// ---- join ------------------------------------------------------------------
$('createBtn').onclick = () => {
  hasLeft = false;
  const name = $('nameInput').value.trim();
  socket.emit('room:create', { name }, (res) => {
    if (res.ok) saveSession({ code: res.code, token: res.token, playerId: res.playerId, name });
    else showJoinError(res.error);
  });
};
$('joinBtn').onclick = () => {
  hasLeft = false;
  const name = $('nameInput').value.trim();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return showJoinError('Enter a room code.');
  socket.emit('room:join', { code, name }, (res) => {
    if (res.ok) saveSession({ code: res.code, token: res.token, playerId: res.playerId, name });
    else showJoinError(res.error);
  });
};
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
function showJoinError(msg) { $('joinError').textContent = msg || ''; }

// ---- match control ---------------------------------------------------------
$('startBtn').onclick = () => socket.emit('room:start', (res) => {
  if (res?.error) $('lobbyHint').textContent = res.error;
});
$('lobbyBtn').onclick = () => socket.emit('room:returnToLobby');
$('leaveBtn').onclick = () => leaveRoom();

// Leave the room and return to the main (join) screen.
function leaveRoom() {
  socket.emit('room:leave');
  hasLeft = true;
  clearSession();
  state = null;
  lastTick = null;
  selectedSideTarget = null;
  sideRowEls.clear(); $('sideBetList').innerHTML = '';
  $('topbar').classList.add('hidden');
  $('sideBets').classList.add('hidden');
  showScreen('join');
  showJoinError('');
}

// Host-only stakes controls.
const readBuyIn = () =>
  parseInt($('buyInInput').value, 10) || state?.config.defaultBuyIn || 500;
$('modeLowBtn').onclick = () => socket.emit('room:setMode', { mode: 'low' });
$('modeHighBtn').onclick = () => socket.emit('room:setMode', { mode: 'high', buyIn: readBuyIn() });
$('buyInInput').onchange = () => socket.emit('room:setMode', { mode: 'high', buyIn: readBuyIn() });

// ---- persistent wallet bar -------------------------------------------------
function updateTopbar() {
  const mp = myPlayer();
  if (state && mp) {
    $('topbar').classList.remove('hidden');
    $('tbName').textContent = mp.name + (mp.role === 'spectator' ? ' · spectating' : '');
    $('tbBankroll').textContent = mp.bankroll;
  } else {
    $('topbar').classList.add('hidden');
  }
}

// ---- betting (poker actions) -----------------------------------------------
document.querySelectorAll('#pokerActions [data-act]').forEach((btn) => {
  btn.onclick = () => {
    $('betError').textContent = '';
    socket.emit('poker:action', { type: btn.dataset.act }, (res) => {
      if (res?.error) $('betError').textContent = res.error;
    });
  };
});

// ---- side bets -------------------------------------------------------------
$('sbfFlip').onclick = () => {
  $('sbfError').textContent = '';
  if (!selectedSideTarget) return;
  const amount = parseInt($('sbfAmount').value, 10);
  if (!amount || amount <= 0) return ($('sbfError').textContent = 'Enter an amount.');
  socket.emit('sidebet:challenge', { targetId: selectedSideTarget, amount }, (res) => {
    if (res?.error) { $('sbfError').textContent = res.error; return; }
    $('sbfAmount').value = '';
    selectedSideTarget = null;
    renderSideBets();
  });
};
$('sbfAmount').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('sbfFlip').click(); });

socket.on('sidebet:flip', (d) => animateCoinFlip(d));

let toastTimer = null;
function showToast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3600);
}

// ---- socket: authoritative room state --------------------------------------
socket.on('state', (s) => {
  if (hasLeft) return; // ignore any in-flight state after leaving
  state = s;
  render();
});

socket.on('game:tick', (frame) => {
  lastTick = frame;
  if (state?.phase === 'playing') drawGame();
});

// Socket.IO auto-reconnects. Whenever the transport (re)connects, if we hold
// a saved session, reclaim our seat. This covers both a mid-game network drop
// and a full page reload.
socket.on('connect', () => {
  if (session?.code && session?.token) rejoin();
});

socket.on('disconnect', () => {
  // Don't bounce to the join screen — keep the seat and show we're retrying.
  if (session) showOverlay('Connection lost — reconnecting…');
});

function rejoin() {
  showOverlay('Reconnecting…');
  socket.emit('room:rejoin', { code: session.code, token: session.token }, (res) => {
    if (res?.ok) {
      me.id = res.playerId; me.code = res.code;
      hideOverlay();
      if (res.state) { state = res.state; render(); }
    } else {
      // Seat is gone (room closed or grace expired). Start fresh.
      clearSession();
      hideOverlay();
      showScreen('join');
      showJoinError(res?.error || 'Could not rejoin your game.');
    }
  });
}

function showOverlay(msg) {
  $('reconnectMsg').textContent = msg;
  $('reconnectOverlay').classList.add('active');
}
function hideOverlay() { $('reconnectOverlay').classList.remove('active'); }

// ---- master render (driven by room state) ----------------------------------
function render() {
  if (!state) return;
  updateTopbar();
  showScreen(screenForPhase(state.phase));

  // Side-bet panel rides along the whole match.
  const inMatch = ['betting', 'countdown', 'playing', 'results'].includes(state.phase);
  $('sideBets').classList.toggle('hidden', !inMatch);
  if (inMatch) renderSideBets();
  else { sideRowEls.clear(); $('sideBetList').innerHTML = ''; selectedSideTarget = null; }

  switch (state.phase) {
    case 'lobby': renderLobby(); break;
    case 'betting': renderBetting(); break;
    case 'countdown': renderCountdown(); break;
    case 'playing': renderPlayingHud(); break;
    case 'results': renderResults(); break;
    case 'gameover': renderGameOver(); break;
  }
}

function screenForPhase(phase) {
  return phase === 'lobby' ? 'lobby' : phase; // phase names map 1:1 to screen ids
}

const myPlayer = () => state?.players.find((p) => p.id === me.id);

// ---- lobby -----------------------------------------------------------------
function renderLobby() {
  $('lobbyCode').textContent = state.code;
  $('minPlayers').textContent = state.config.minPlayers;
  const isHost = me.id === state.hostId;
  const high = state.mode === 'high';
  const canAfford = (p) => !high || p.bankroll >= state.buyIn;

  // Stakes controls (host) / summary (everyone).
  $('modeLowBtn').classList.toggle('active', !high);
  $('modeHighBtn').classList.toggle('active', high);
  $('buyInRow').classList.toggle('hidden', !high);
  if (document.activeElement !== $('buyInInput')) $('buyInInput').value = state.buyIn;
  for (const el of [$('modeLowBtn'), $('modeHighBtn'), $('buyInInput')]) el.disabled = !isHost;
  $('modeSummary').textContent = high
    ? `High-stakes: each player pays ${state.buyIn} from their bankroll. Bust to 0 and you're eliminated to spectator for the rest of the match.`
    : `Low-stakes: the house stakes everyone ${state.config.lowStipend} free chips to start the match. Make it last — bust to 0 and you spectate until the next match.`;

  const list = $('lobbyPlayers');
  list.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    const host = p.id === state.hostId ? '<span class="host-tag">HOST</span>' : '';
    const away = p.connected ? '' : '<span class="away-tag">AWAY</span>';
    const broke = high && !canAfford(p) ? '<span class="out-tag">CAN\'T AFFORD</span>' : '';
    const you = p.id === me.id ? ' (you)' : '';
    li.innerHTML = `<span><span style="color:${colorFor(p.id)}">●</span> ${escape(p.name)}${you}${host}${away}${broke}</span>
      <span class="pchips">💰 ${p.bankroll}</span>`;
    list.appendChild(li);
  }

  const eligible = state.players.filter((p) => p.connected && canAfford(p)).length;
  const enough = eligible >= state.config.minPlayers;
  $('startBtn').style.display = isHost ? 'block' : 'none';
  $('startBtn').disabled = !enough;
  $('lobbyHint').textContent = isHost
    ? (enough ? '' : high
        ? `Need ${state.config.minPlayers}+ players who can afford the ${state.buyIn} buy-in.`
        : 'Waiting for more players…')
    : 'Waiting for the host to start…';
}

// ---- betting (poker felt table) --------------------------------------------
const ACTION_LABEL = { check: 'CHECK', call: 'CALL', bet: 'BET', raise: 'RAISE', fold: 'FOLD' };

function renderBetting() {
  const pk = state.poker;
  const gameName = state.minigame?.name || 'the minigame';
  const proportional = state.minigame?.payout === 'proportional';
  $('betRound').textContent = `${state.round} / ${state.totalRounds}`;
  $('betGameName').textContent = state.minigame?.name || '';
  $('betTagline').innerHTML = proportional
    ? `Grab coins in <b>${escape(gameName)}</b> — your cut of the pot scales with how many you collect. Fold to sit out.`
    : `Bet on yourself to win <b>${escape(gameName)}</b> — winner takes the whole pot. Fold to sit out.`;
  $('betStakes').textContent = state.mode === 'high'
    ? `High-stakes · ${state.buyIn} buy-in`
    : `Low-stakes · ${state.config.lowStipend} stake`;
  if (!pk) return;

  $('potAmount').textContent = pk.pot;
  $('feltSub').textContent = pk.currentBet > 0
    ? `current bet ${pk.currentBet}`
    : (proportional ? 'pot shared by coins' : 'winner takes the pot');

  renderSeats(pk);

  const meP = myPlayer();
  const amSpectator = meP?.role === 'spectator';
  const amFolded = pk.folded.includes(me.id);
  const myTurn = pk.toActId === me.id;

  // Banner for anyone who can't act (spectating or folded this hand).
  const banner = $('betSpectatorBanner');
  banner.classList.toggle('hidden', !(amSpectator || amFolded));
  if (amSpectator) banner.textContent = "👀 You're spectating this match.";
  else if (amFolded) banner.textContent = '🙅 You folded — sitting this minigame out.';

  // Your action bar only appears on your turn.
  $('pokerActions').classList.toggle('hidden', !myTurn);
  if (myTurn && meP) {
    const toCall = Math.max(0, pk.currentBet - (pk.committed[me.id] || 0));
    const underCap = pk.betLevel < pk.betCap;
    $('toCallInfo').innerHTML = toCall > 0
      ? `To stay in you must call <b>${Math.min(toCall, meP.chips)}</b> · you have ${meP.chips}`
      : `It's checked to you · you have ${meP.chips} chips`;
    setAct('check', toCall === 0, 'Check');
    setAct('call', toCall > 0, `Call ${Math.min(toCall, meP.chips)}`);
    setAct('bet', toCall === 0 && underCap && meP.chips > 0, `Bet ${Math.min(state.betSize, meP.chips)}`);
    setAct('raise', toCall > 0 && underCap && meP.chips > toCall, `Raise to ${pk.currentBet + state.betSize}`);
    setAct('fold', true, 'Fold');
    startTurnBar(pk.turnEndsAt);
  }

  $('betStatus').textContent = myTurn ? '⏱ Your turn — choose an action above.'
    : pk.toActId ? `Waiting for ${nameOf(pk.toActId)} to act…` : 'Dealing the next hand…';
}

// Build/refresh the seats around the felt (keyed by id for smooth updates).
function renderSeats(pk) {
  const seatsBox = $('seats');
  const chipsBox = $('betChips');
  const order = pk.order;
  const seen = new Set(order);

  // Position seats around an ellipse, with "me" anchored at the bottom.
  const n = order.length;
  let myIdx = order.indexOf(me.id);
  if (myIdx < 0) myIdx = 0;

  order.forEach((id, i) => {
    const p = state.players.find((x) => x.id === id);
    if (!p) return;
    const k = (i - myIdx + n) % n;                 // 0 = bottom (me)
    const ang = Math.PI / 2 + k * (2 * Math.PI / n);
    const sx = 50 + 46 * Math.cos(ang), sy = 50 + 40 * Math.sin(ang);
    const bx = 50 + 26 * Math.cos(ang), by = 50 + 23 * Math.sin(ang);
    const topHalf = Math.sin(ang) < -0.05;          // seat sits above the table center

    // Seat element.
    let seat = seatEls.get(id);
    if (!seat) {
      seat = document.createElement('div');
      seat.className = 'seat';
      // Labels live in their own wrapper so they can extend OUTWARD from the
      // table (up for top seats, down for bottom seats) and never cover the felt.
      seat.innerHTML =
        '<div class="avatar"></div>' +
        '<div class="seat-labels">' +
          '<div class="seat-plate"><div class="seat-name"></div><div class="seat-stack"></div></div>' +
          '<div class="seat-badge empty"></div>' +
        '</div>' +
        '<div class="dealer-btn" style="display:none">D</div>';
      seatEls.set(id, seat);
      seatsBox.appendChild(seat);
    }
    seat.style.left = sx + '%';
    seat.style.top = sy + '%';
    const folded = pk.folded.includes(id);
    const allIn = pk.allIn.includes(id);
    seat.classList.toggle('is-top', topHalf);
    seat.classList.toggle('is-bottom', !topHalf);
    seat.classList.toggle('to-act', pk.toActId === id);
    seat.classList.toggle('folded', folded);
    seat.classList.toggle('me', id === me.id);
    seat.classList.toggle('away', !p.connected && !folded);

    const av = seat.querySelector('.avatar');
    av.textContent = initials(p.name);
    av.style.background = colorFor(id);
    seat.querySelector('.seat-name').textContent = p.name + (id === me.id ? '' : '');
    seat.querySelector('.seat-stack').innerHTML = allIn ? '<b>ALL IN</b>' : `<b>${p.chips}</b> chips`;
    seat.querySelector('.dealer-btn').style.display = id === pk.dealerId ? 'flex' : 'none';

    // Status badge: last action / all-in / waiting.
    const badge = seat.querySelector('.seat-badge');
    const { text, cls } = badgeFor(pk, id);
    badge.textContent = text;
    badge.className = 'seat-badge ' + cls;
    if (prevAction.get(id) !== text && text) badge.classList.add('pop');
    prevAction.set(id, text);

    // Bet chips pushed in front of the seat.
    const committed = pk.committed[id] || 0;
    let chip = betEls.get(id);
    if (committed > 0) {
      if (!chip) { chip = document.createElement('div'); chip.className = 'bet-chip'; chipsBox.appendChild(chip); betEls.set(id, chip); }
      chip.textContent = committed;
      chip.style.left = bx + '%';
      chip.style.top = by + '%';
    } else if (chip) { chip.remove(); betEls.delete(id); }
  });

  // Remove seats/chips for players no longer seated (e.g. between rounds).
  for (const [id, el] of seatEls) if (!seen.has(id)) { el.remove(); seatEls.delete(id); prevAction.delete(id); }
  for (const [id, el] of betEls) if (!seen.has(id)) { el.remove(); betEls.delete(id); }
}

function badgeFor(pk, id) {
  if (pk.folded.includes(id)) return { text: 'FOLD', cls: 'act-fold' };
  if (pk.allIn.includes(id)) return { text: 'ALL IN', cls: 'act-allin' };
  if (pk.toActId === id) return { text: 'THINKING', cls: '' };
  const last = pk.lastAction[id];
  if (last && ACTION_LABEL[last]) return { text: ACTION_LABEL[last], cls: 'act-' + last };
  return { text: '', cls: 'empty' };
}

// Show/label a poker action button; hide the ones that don't apply (fold stays).
function setAct(type, enabled, label) {
  const btn = document.querySelector(`#pokerActions [data-act="${type}"]`);
  btn.textContent = label;
  btn.disabled = !enabled;
  btn.classList.toggle('hidden', !enabled && type !== 'fold');
}

// Depleting bar for the remaining time on your turn.
function startTurnBar(endsAt) {
  const fill = $('turnFill');
  const remain = Math.max(0, endsAt - Date.now());
  fill.style.transition = 'none';
  fill.style.width = '100%';
  // Force a reflow so the transition restarts, then animate down to empty.
  void fill.offsetWidth;
  fill.style.transition = `width ${remain}ms linear`;
  fill.style.width = '0%';
}

function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || parts[0]?.[1] || '')).toUpperCase();
}

// ---- side bets -------------------------------------------------------------
function renderSideBets() {
  const list = $('sideBetList');
  const others = state.players.filter((p) => p.id !== me.id);
  const seen = new Set(others.map((p) => p.id));
  const pending = state.sideBets || [];

  // Toast any brand-new challenge aimed at me, then forget settled ones.
  for (const sb of pending) {
    if (sb.toId === me.id && !seenIncoming.has(sb.id)) {
      seenIncoming.add(sb.id);
      const from = state.players.find((p) => p.id === sb.fromId);
      showToast(`⚔️ ${from?.name || 'Someone'} dares you to flip for ${sb.amount}!`);
    }
  }
  const liveIds = new Set(pending.map((sb) => sb.id));
  for (const id of [...seenIncoming]) if (!liveIds.has(id)) seenIncoming.delete(id);

  for (const p of others) {
    let row = sideRowEls.get(p.id);
    if (!row) {
      row = document.createElement('li');
      row.className = 'sb-row';
      // The coin-slot is left untouched by updates so its flip animation survives re-renders.
      row.innerHTML = '<span class="sb-dot"></span><span class="sb-name"></span>'
        + '<span class="sb-bank"></span>'
        + `<span class="coin-slot" data-pid="${p.id}"></span>`
        + '<span class="sb-actions"></span>';
      sideRowEls.set(p.id, row);
      list.appendChild(row);
    }
    const incoming = pending.find((sb) => sb.toId === me.id && sb.fromId === p.id);
    const outgoing = pending.find((sb) => sb.fromId === me.id && sb.toId === p.id);

    row.querySelector('.sb-dot').style.background = colorFor(p.id);
    row.querySelector('.sb-name').textContent = p.name;
    row.querySelector('.sb-bank').textContent = '💰' + p.bankroll;
    row.classList.toggle('away', !p.connected);
    row.classList.toggle('incoming', !!incoming);
    row.classList.toggle('selected', selectedSideTarget === p.id);

    const actions = row.querySelector('.sb-actions');
    actions.innerHTML = '';
    if (incoming) {
      actions.append(
        miniBtn('Flip ' + incoming.amount, 'yes', () => respondSide(incoming.id, true)),
        miniBtn('✕', 'no', () => respondSide(incoming.id, false)),
      );
      row.onclick = null;
    } else if (outgoing) {
      const w = document.createElement('span');
      w.className = 'sb-wait';
      w.textContent = '⏳ ' + outgoing.amount;
      actions.appendChild(w);
      row.onclick = null;
    } else if (p.connected) {
      row.onclick = () => { selectedSideTarget = selectedSideTarget === p.id ? null : p.id; renderSideBets(); };
    } else {
      row.onclick = null;
    }
  }

  for (const [pid, el] of sideRowEls) if (!seen.has(pid)) { el.remove(); sideRowEls.delete(pid); }

  // Challenge form for the currently selected (and still valid) target.
  const target = selectedSideTarget && state.players.find((p) => p.id === selectedSideTarget);
  const busy = target && pending.some((sb) =>
    (sb.fromId === me.id && sb.toId === target.id) || (sb.toId === me.id && sb.fromId === target.id));
  const showForm = target && target.connected && !busy;
  if (selectedSideTarget && !showForm) selectedSideTarget = null;
  $('sideBetForm').classList.toggle('hidden', !showForm);
  if (showForm) $('sbfName').textContent = target.name;
}

function respondSide(id, accept) {
  socket.emit('sidebet:respond', { id, accept }, (res) => {
    if (res?.error) showToast(res.error);
  });
}

function miniBtn(label, kind, onClick) {
  const b = document.createElement('button');
  b.className = 'pa sb-mini ' + kind;
  b.textContent = label;
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

// Spin a coin next to each involved player; reveal the result on landing.
function animateCoinFlip(d) {
  for (const pid of [d.fromId, d.toId]) {
    const slot = document.querySelector(`.coin-slot[data-pid="${pid}"]`);
    if (!slot) continue;
    const won = pid === d.winnerId;
    slot.innerHTML = '<span class="coin">🪙</span>';
    setTimeout(() => {
      if (!slot.isConnected) return;
      slot.innerHTML = `<span class="coin-result ${won ? 'win' : 'lose'}">${won ? '+' : '−'}${d.amount}</span>`;
      setTimeout(() => { if (slot.isConnected) slot.innerHTML = ''; }, 2600);
    }, 1300);
  }
  if (d.fromId === me.id || d.toId === me.id) {
    const won = d.winnerId === me.id;
    const opp = d.fromId === me.id ? d.toName : d.fromName;
    showToast(`🪙 You ${won ? 'won' : 'lost'} ${d.amount} ${won ? 'from' : 'to'} ${opp}!`, won ? 'win' : 'lose');
  }
}

// ---- countdown -------------------------------------------------------------
function renderCountdown() {
  const tick = () => {
    const remain = Math.max(0, Math.ceil((state.phaseEndsAt - Date.now()) / 1000));
    $('countdownNum').textContent = remain > 0 ? remain : 'GO!';
  };
  tick();
  clearInterval(window._cd);
  window._cd = setInterval(tick, 100);
}

// ---- playing ---------------------------------------------------------------
function renderPlayingHud() {
  clearInterval(window._cd);
  const amSpectator = myPlayer()?.role === 'spectator';
  const amFolded = state.poker?.folded.includes(me.id);
  const banner = $('playSpectatorBanner');
  banner.classList.toggle('hidden', !(amSpectator || amFolded));
  banner.textContent = amFolded ? '🙅 You folded — watching for the pot.' : '👀 Spectating — watching the action live.';
  $('playPot').textContent = state.poker ? `POT ${state.poker.pot}` : '';
  if (lastTick) drawGame();
}

const canvas = $('gameCanvas');
const ctx = canvas.getContext('2d');

function drawGame() {
  const f = lastTick;
  if (!f) return;
  canvas.width = f.arena.width;
  canvas.height = f.arena.height;

  $('gameTimer').textContent = `${f.timeLeft}s`;
  const sb = $('gameScores');
  sb.innerHTML = '';
  [...f.players].sort((a, b) => b.score - a.score).forEach((p) => {
    const d = document.createElement('div');
    d.className = 'sb';
    d.style.color = colorFor(p.id);
    d.textContent = `${p.name}: ${p.score}`;
    sb.appendChild(d);
  });

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Coins.
  for (const c of f.coins) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#ffcd3c';
    ctx.fill();
    ctx.strokeStyle = '#b8860b';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Players.
  for (const p of f.players) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
    ctx.fillStyle = colorFor(p.id);
    ctx.fill();
    if (p.id === me.id) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke(); }
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, p.x, p.y - 24);
  }
}

// ---- keyboard input (only matters during PLAYING) --------------------------
const keys = { up: false, down: false, left: false, right: false };
const KEYMAP = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
};
function onKey(e, down) {
  const k = KEYMAP[e.code];
  if (!k) return;
  // Never hijack typing in a text field (room code, name, buy-in…).
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  // Movement only matters while a minigame is being played.
  if (state?.phase !== 'playing') return;
  e.preventDefault();
  keys[k] = down;
}
window.addEventListener('keydown', (e) => onKey(e, true));
window.addEventListener('keyup', (e) => onKey(e, false));

// Send the current movement direction at the simulation rate.
setInterval(() => {
  if (state?.phase !== 'playing') return;
  const dir = {
    x: (keys.right ? 1 : 0) - (keys.left ? 1 : 0),
    y: (keys.down ? 1 : 0) - (keys.up ? 1 : 0),
  };
  socket.emit('input:move', dir);
}, 1000 / 20);

// ---- results ---------------------------------------------------------------
function renderResults() {
  const r = state.result;
  if (!r) return;
  const proportional = r.minigame.payout === 'proportional';
  $('resRound').textContent = r.round;
  $('resWinnerLine').textContent = r.winnerName
    ? (r.uncontested
        ? `🏆 ${r.winnerName} took the ${r.pot} pot — everyone else folded!`
        : proportional
          ? `🥇 ${r.winnerName} grabbed the most — the ${r.pot} pot is split by coins!`
          : `🏆 ${r.winnerName} won ${r.minigame.name} and took the ${r.pot} pot!`)
    : 'No winner this round.';

  const scores = $('resScores');
  scores.innerHTML = '';
  if (r.uncontested || !r.scores.length) {
    scores.innerHTML = '<li><span>No minigame — everyone folded.</span></li>';
  } else {
    r.scores.forEach((s, i) => {
      const li = document.createElement('li');
      const crown = i === 0 ? '🏆 ' : '';
      li.innerHTML = `<span>${crown}<span style="color:${colorFor(s.id)}">${escape(s.name)}</span></span><span>${s.score}</span>`;
      scores.appendChild(li);
    });
  }

  $('resPool').textContent = `(pot: ${r.pot} chips)`;

  // Each player's chip outcome: what they put in vs. what they took.
  const pay = $('resPayouts');
  pay.innerHTML = '';
  for (const b of r.breakdown) {
    const li = document.createElement('li');
    const cls = b.net > 0 ? 'net-pos' : b.net < 0 ? 'net-neg' : '';
    const sign = b.net > 0 ? '+' : '';
    const tag = b.folded ? ' <span class="spec-tag">folded</span>' : '';
    li.innerHTML = `<span><span style="color:${colorFor(b.id)}">${escape(b.name)}</span>${tag} · in ${b.contributed}</span>
      <span>won <b>${b.won}</b> <span class="${cls}">(${sign}${b.net})</span></span>`;
    pay.appendChild(li);
  }
}

// ---- game over -------------------------------------------------------------
function renderGameOver() {
  const fs = state.finalStandings || { standings: [], spectators: [] };
  const list = $('finalStandings');
  list.innerHTML = '';

  fs.standings.forEach((p, i) => {
    const li = document.createElement('li');
    const medal = ['🥇', '🥈', '🥉'][i] || '';
    const cls = p.net > 0 ? 'net-pos' : p.net < 0 ? 'net-neg' : '';
    const sign = p.net > 0 ? '+' : '';
    li.innerHTML = `<span><span class="rank">${medal || i + 1}</span>
      <span style="color:${colorFor(p.id)}">${escape(p.name)}</span> · ${p.wins} wins</span>
      <span>💰 ${p.bankroll} <span class="${cls}">(${sign}${p.net})</span></span>`;
    list.appendChild(li);
  });

  // Spectators / eliminated players this match.
  for (const s of fs.spectators) {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="rank">—</span>
      <span style="color:${colorFor(s.id)}">${escape(s.name)}</span> <span class="spec-tag">SPECTATED</span></span>
      <span>💰 ${s.bankroll}</span>`;
    list.appendChild(li);
  }

  const isHost = me.id === state.hostId;
  $('lobbyBtn').style.display = isHost ? 'block' : 'none';
  $('gameoverHint').textContent = isHost ? '' : 'Waiting for the host to return to the lobby…';
}

// ---- helpers ---------------------------------------------------------------
function nameOf(id) { return state?.players.find((p) => p.id === id)?.name || '?'; }
function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

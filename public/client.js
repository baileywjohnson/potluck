/* global io */
const socket = io();

// ---- local client state ----------------------------------------------------
const me = { id: null, code: null };
let state = null;          // latest authoritative room snapshot
let lastTick = null;       // latest minigame frame during PLAYING
let snapshots = [];        // recent {t, frame} buffer for smooth interpolation
let rafId = null;          // requestAnimationFrame handle for the render loop
const RENDER_DELAY = 70;   // ms rendered behind real time so we can interpolate

// Felt table: keep seat/bet-chip elements keyed by player id so they update in
// place (smooth transitions) instead of being rebuilt every frame.
const seatEls = new Map();
const betEls = new Map();
const prevAction = new Map(); // id -> last action seen, to pop the badge on change

// Side Bets.
const sideRowEls = new Map();    // pid -> side-bet list row element
const seenIncoming = new Set();  // challenge ids we've already toasted
let selectedSideTarget = null;   // who I'm about to challenge

// Type Race.
const typeLanes = new Map();     // pid -> race lane element
let currentParagraph = '';       // the paragraph being typed this round
let typingStarted = false;       // set-up-once guard per typing round

// Fruit Drop (Suika).
let localBoardRect = null;       // my jar's on-canvas rect (for aim/drop input)
let lastAimSent = 0;
let suikaRadii = null;           // fruit radii (logical) from the current frame
const fruitSprites = new Map();  // `${type}@${SS}` -> pre-rendered gradient fruit
const suikaPrevScore = new Map(); // board id -> last score (to pop merge sparkles)
const suikaPrevIds = new Map();   // board id -> Set of fruit ids last frame
const FRUIT_COLORS = ['#e0564a', '#ef6f9f', '#a06cd5', '#f0883a', '#e85c2a', '#e84d4d', '#e6c145', '#f2a8b4', '#6fae5f'];

// Trapdoor.
let tileRects = null;            // [{x,y,w,h}] per tile index (for click -> place)
let tileSpr = null;              // cached wooden-tile sprite
const trapPrevTile = new Map();  // id -> last tile (for elimination puffs)
const trapPrevElim = new Set();  // ids already eliminated

// Lightcycles (Tron).
let trailCells = [];             // accumulated {x,y,color} trail cells for the round
const tronPrevAlive = new Set(); // ids alive last frame (to spawn crash bursts)

// Chat.
let chatCollapsed = false;       // header toggles the body
let chatUnread = 0;              // messages arrived while collapsed

const $ = (id) => document.getElementById(id);

// ---- session persistence (for reconnect / reload) --------------------------
// We remember the room code + secret token so the same seat can be reclaimed
// after a network drop or a full page refresh. We use sessionStorage (not
// localStorage) so it's scoped to THIS tab/window — that lets you open several
// windows on one machine as different players without their sessions colliding.
const SESSION_KEY = 'potluck.session';
const store = window.sessionStorage;
let session = loadSession();
let hasLeft = false; // true after an explicit Leave, so stale states are ignored

// Account login (optional). Unlike the per-tab room session above, the auth
// token lives in localStorage so a login persists across reloads and is shared
// by all tabs — that's the expected behaviour for "stay signed in".
const AUTH_KEY = 'potluck.auth';
let account = null;                 // { id, username, bankroll, xp, wins } when signed in
let authToken = readAuthToken();
function readAuthToken() { try { return window.localStorage.getItem(AUTH_KEY) || null; } catch { return null; } }
function writeAuthToken(t) { try { t ? window.localStorage.setItem(AUTH_KEY, t) : window.localStorage.removeItem(AUTH_KEY); } catch {} }

// A stable id for THIS browser, kept in localStorage so every tab shares it.
// The server uses it to stop one browser taking two seats at the same table.
// The room session above stays per-tab, so you can still be in two *different*
// rooms in two tabs. If storage is unavailable (private mode) this is null and
// the server simply skips the check.
const DEVICE_KEY = 'potluck.device';
const deviceId = loadDeviceId();
function loadDeviceId() {
  try {
    let id = window.localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch { return null; }
}

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
// On a successful create/join, render straight from the ack's state (me.id is
// set first) so the UI — topbar included — appears immediately, even if the
// next 'state' broadcast is a while off (e.g. joining mid-match as a spectator).
function enterRoom(res, name) {
  saveSession({ code: res.code, token: res.token, playerId: res.playerId, name });
  if (res.state) { state = res.state; render(); }
}
// Logged in → the server uses your account name; guests use the name field.
const playerName = () => (account ? account.username : $('nameInput').value.trim());
$('createBtn').onclick = () => {
  hasLeft = false;
  const name = playerName();
  socket.emit('room:create', { name, deviceId }, (res) => {
    if (res.ok) enterRoom(res, name);
    else showJoinError(res.error);
  });
};
$('joinBtn').onclick = () => {
  hasLeft = false;
  const name = playerName();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return showJoinError('Enter a room code.');
  socket.emit('room:join', { code, name, deviceId }, (res) => {
    if (res.ok) enterRoom(res, name);
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
  $('chat').classList.add('hidden');
  $('chatLog').innerHTML = '';
  showScreen('join');
  showJoinError('');
}

// Host-only stakes controls.
const readBuyIn = () =>
  parseInt($('buyInInput').value, 10) || state?.config.defaultBuyIn || 500;
$('modeLowBtn').onclick = () => socket.emit('room:setMode', { mode: 'low' });
$('modeHighBtn').onclick = () => socket.emit('room:setMode', { mode: 'high', buyIn: readBuyIn() });
$('buyInInput').onchange = () => socket.emit('room:setMode', { mode: 'high', buyIn: readBuyIn() });
// Buy-in is a whole number of chips: block anything that isn't a digit (type=number
// otherwise still accepts "e", ".", "+", "-", and lets you paste letters).
$('buyInInput').addEventListener('beforeinput', (e) => {
  if (e.data && /\D/.test(e.data)) e.preventDefault();
});

// ---- persistent wallet bar -------------------------------------------------
// Click the room code to copy it to the clipboard.
$('tbCode').title = 'Click to copy';
$('tbCode').onclick = () => {
  const code = state?.code;
  if (!code) return;
  const done = () => showToast(`📋 Copied room code ${code}`);
  const fail = () => showToast('Could not copy the code');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(code).then(done, () => fallbackCopy(code, done, fail));
  } else {
    fallbackCopy(code, done, fail);
  }
};
function fallbackCopy(text, done, fail) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    done();
  } catch { fail(); }
}

function updateTopbar() {
  const mp = myPlayer();
  if (state && mp) {
    $('topbar').classList.remove('hidden');
    $('tbName').innerHTML = (mp.authed ? '<span class="tb-authed" title="Signed in — progress saved">👤</span> ' : '') +
      escape(mp.name) + (mp.role === 'spectator' ? ' · spectating' : '');
    const pct = mp.xpForLevel ? Math.round((mp.xpInLevel / mp.xpForLevel) * 100) : 0;
    $('tbXp').innerHTML =
      `<span class="lvl">Lv ${mp.level || 1}</span>` +
      `<span class="xpbar" title="${mp.xpInLevel}/${mp.xpForLevel} XP"><span class="xpfill" style="width:${pct}%"></span></span>`;
    $('tbCode').innerHTML = state.code ? `Room: <strong>${escape(state.code)}</strong>` : '';
    $('tbBankroll').textContent = mp.bankroll;
  } else {
    $('topbar').classList.add('hidden');
  }
}

// A compact "Lv N" badge used in the lobby + side-bet lists.
function levelTag(p) {
  return `<span class="lvl-tag">Lv ${p?.level || 1}</span>`;
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

// ---- Side Bets -------------------------------------------------------------
$('sbfFlip').onclick = () => {
  $('sbfError').textContent = '';
  if (!selectedSideTarget) return;
  const amount = parseInt($('sbfAmount').value, 10);
  if (!amount || amount <= 0) return ($('sbfError').textContent = 'Enter a valid amount.');
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
  if (state?.phase !== 'playing') return;
  if (frame.mode === 'typing') { renderTypeRace(frame); return; }
  // Every canvas minigame buffers snapshots; the rAF loop draws them.
  snapshots.push({ t: performance.now(), frame });
  if (snapshots.length > 20) snapshots.shift();
  if (frame.mode === 'tron') {
    // Trails are sent incrementally; accumulate them with their owner colour.
    for (const t of (frame.newTrail || [])) trailCells.push({ x: t.x, y: t.y, color: colorFor(t.id) });
    return;
  }
  if (frame.mode === 'suika' || frame.mode === 'tiles') return;
  updateGameHud(frame); // Coin Rush: scores/timer at the tick rate; motion is smoothed
  detectEvents(frame);  // spawn pickup/hit/muzzle sparkles
});

// ---- chat ------------------------------------------------------------------
socket.on('chat:history', (msgs) => renderChatHistory(msgs));
socket.on('chat:msg', (msg) => appendChatMsg(msg));

function updateChatUnread() {
  const b = $('chatUnread');
  b.textContent = chatUnread > 9 ? '9+' : String(chatUnread);
  b.classList.toggle('hidden', chatUnread === 0);
}
// Build a message row with textContent (never innerHTML) so messages can't inject markup.
function appendChatMsg(msg) {
  const log = $('chatLog');
  const empty = log.querySelector('.chat-empty');
  if (empty) empty.remove();
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  const row = document.createElement('div');
  row.className = 'chat-msg' + (msg.playerId === me.id ? ' me' : '');
  const nm = document.createElement('span'); nm.className = 'cm-name'; nm.textContent = `${msg.name}: `;
  const tx = document.createElement('span'); tx.className = 'cm-text'; tx.textContent = msg.text;
  row.append(nm, tx);
  log.appendChild(row);
  if (nearBottom) log.scrollTop = log.scrollHeight;
  if (chatCollapsed && msg.playerId !== me.id) { chatUnread++; updateChatUnread(); }
}
function renderChatHistory(msgs) {
  const log = $('chatLog');
  log.innerHTML = '';
  if (!msgs || !msgs.length) {
    const e = document.createElement('div'); e.className = 'chat-empty'; e.textContent = 'No messages yet — say hi!';
    log.appendChild(e);
  } else {
    msgs.forEach(appendChatMsg);
  }
  log.scrollTop = log.scrollHeight;
  chatUnread = 0; updateChatUnread();
}

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat:send', text);
  input.value = '';
});
$('chatHeader').onclick = () => {
  chatCollapsed = !chatCollapsed;
  $('chat').classList.toggle('collapsed', chatCollapsed);
  if (!chatCollapsed) { chatUnread = 0; updateChatUnread(); }
};

// Socket.IO auto-reconnects. Whenever the transport (re)connects, if we hold
// a saved session, reclaim our seat. This covers both a mid-game network drop
// and a full page reload.
socket.on('connect', () => {
  // Re-establish the account login on this (possibly new) socket first, so any
  // room we create/join afterwards is tied to the account.
  if (authToken) {
    socket.emit('auth:resume', { token: authToken }, (res) => {
      if (res?.ok) applyAuth(res.user, authToken);
      else clearAuth();
    });
  }
  if (session?.code && session?.token) rejoin();
});

// ---- accounts --------------------------------------------------------------
function applyAuth(user, token) {
  account = user;
  authToken = token;
  writeAuthToken(token);
  updateAuthUI();
}
function clearAuth() {
  account = null;
  authToken = null;
  writeAuthToken(null);
  updateAuthUI();
}
function updateAuthUI() {
  const inAcct = !!account;
  $('authForm').classList.toggle('hidden', inAcct);
  $('authStatus').classList.toggle('hidden', !inAcct);
  $('nameInput').classList.toggle('hidden', inAcct); // logged in → name comes from the account
  if (inAcct) $('authWho').textContent = account.username;
  if (!inAcct) { $('authError').textContent = ''; }
}
function doAuth(kind) {
  const name = $('authUser').value.trim();
  const password = $('authPass').value;
  $('authError').textContent = '';
  socket.emit(`auth:${kind}`, { name, password }, (res) => {
    if (res?.ok) {
      applyAuth(res.user, res.token);
      $('authPass').value = '';
      showToast(kind === 'signup' ? `Welcome, ${res.user.username}!` : `Signed in as ${res.user.username}`);
    } else {
      $('authError').textContent = res?.error || 'Something went wrong.';
    }
  });
}
$('loginBtn').onclick = () => doAuth('login');
$('signupBtn').onclick = () => doAuth('signup');
$('authPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });
$('logoutBtn').onclick = () => {
  socket.emit('auth:logout', () => {});
  clearAuth();
  showToast('Logged out');
};
updateAuthUI(); // reflect the (logged-out) starting state immediately

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
  $('chat').classList.remove('hidden'); // chat is available the whole time you're in a room
  showScreen(screenForPhase(state.phase));

  // Side-bet panel is available in the lobby and all the way through a match.
  const sideOpen = ['lobby', 'betting', 'countdown', 'playing', 'results'].includes(state.phase);
  $('sideBets').classList.toggle('hidden', !sideOpen);
  if (sideOpen) renderSideBets();
  else { sideRowEls.clear(); $('sideBetList').innerHTML = ''; selectedSideTarget = null; }

  if (state.phase !== 'playing') typingStarted = false; // re-setup on next typing round

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
    ? `High-stakes: each player buys in from their stash.`
    : `Low-stakes: the house stakes everyone ${state.config.lowStipend} free chips to start the match.`;

  const list = $('lobbyPlayers');
  list.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    const host = p.id === state.hostId ? '<span class="host-tag">HOST</span>' : '';
    const away = p.connected ? '' : '<span class="away-tag">AWAY</span>';
    const broke = high && !canAfford(p) ? '<span class="out-tag">POOR</span>' : '';
    const you = p.id === me.id ? ' (you)' : '';
    li.innerHTML = `<span><span style="color:${colorFor(p.id)}">●</span> ${escape(p.name)}${you} ${levelTag(p)}${host}${away}${broke}</span>
      <span class="pchips"><span class="chip-icon"></span> ${p.bankroll}</span>`;
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
  $('betRound').textContent = `${state.round} / ${state.totalRounds}`;
  $('betGameName').textContent = state.minigame?.name || '';
  $('betStakes').textContent = (state.mode === 'high'
    ? `High-stakes · ${state.buyIn} buy-in`
    : `Low-stakes · ${state.config.lowStipend} stake`) + ` · ${state.blind} blind`;
  if (!pk) return;

  $('potAmount').textContent = pk.pot;
  $('feltSub').textContent = pk.currentBet > pk.blindAmount
    ? `current bet ${pk.currentBet}`
    : 'winner takes the pot';

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
    const opened = pk.currentBet > 0;   // the blind opens the betting
    const iAmBlind = pk.blindId === me.id;
    $('toCallInfo').innerHTML = toCall > 0
      ? `To stay in you must call <b>${Math.min(toCall, meP.chips)}</b> · you have ${meP.chips}`
      : iAmBlind
        ? `You're on the blind for <b>${pk.blindAmount}</b> · you have ${meP.chips} chips`
        : `It's checked to you · you have ${meP.chips} chips`;
    setAct('check', toCall === 0, 'Check');
    setAct('call', toCall > 0, `Call ${Math.min(toCall, meP.chips)}`);
    setAct('bet', !opened && underCap && meP.chips > 0, `Bet ${Math.min(state.betSize, meP.chips)}`);
    setAct('raise', opened && underCap && meP.chips > toCall, `Raise to ${pk.currentBet + state.betSize}`);
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
  // With exactly two players the top seat sits right above the pot, so nudge
  // the pot down to clear it (3+ players fan out to the sides — no conflict).
  $('felt').classList.toggle('duo', n === 2);
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
        '<div class="dealer-btn" title="Dealer button — posts this round\'s blind" style="display:none">D</div>';
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

// ---- Side Bets -------------------------------------------------------------
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
      // Layout mirrors a lobby row: [dot · name · Lv badge] on the left, the
      // bankroll right-aligned. The accept/decline actions float in the gutter to
      // the right (see .sb-actions) — and the coin flip animates there too.
      row.innerHTML = '<span class="sb-dot"></span><span class="sb-name"></span>'
        + '<span class="sb-lvl lvl-tag"></span>'
        + '<span class="sb-actions"></span>'
        + '<span class="sb-bank"></span>';
      sideRowEls.set(p.id, row);
      list.appendChild(row);
    }
    const incoming = pending.find((sb) => sb.toId === me.id && sb.fromId === p.id);
    const outgoing = pending.find((sb) => sb.fromId === me.id && sb.toId === p.id);

    row.querySelector('.sb-dot').style.background = colorFor(p.id);
    row.querySelector('.sb-name').textContent = p.name;
    row.querySelector('.sb-lvl').textContent = 'Lv ' + (p.level || 1);
    row.querySelector('.sb-bank').innerHTML = '<span class="chip-icon"></span> ' + p.bankroll;
    row.classList.toggle('away', !p.connected);
    row.classList.toggle('incoming', !!incoming);
    row.classList.toggle('selected', selectedSideTarget === p.id);

    // While a coin is flipping in this row's gutter, leave .sb-actions alone so
    // the animation (and its result) survives the resolving state broadcast.
    if (row.dataset.flipping) { row.onclick = null; continue; }

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

// Flip a coin right where the Flip/✕ buttons were — in each involved player's
// gutter — then reveal the +/− result there. If I'm in the bet I only see the
// opponent's row, so show MY outcome there; as a spectator each row shows that
// player's own outcome.
function animateCoinFlip(d) {
  const involvedMe = d.fromId === me.id || d.toId === me.id;
  for (const pid of [d.fromId, d.toId]) {
    const row = sideRowEls.get(pid);
    if (!row) continue; // my own row isn't in the list
    const actions = row.querySelector('.sb-actions');
    const won = involvedMe ? d.winnerId === me.id : pid === d.winnerId;
    row.dataset.flipping = '1';        // tell renderSideBets to leave this alone
    actions.innerHTML = '<span class="coin">🪙</span>';
    setTimeout(() => {
      if (!row.isConnected) return;
      actions.innerHTML = `<span class="coin-result ${won ? 'win' : 'lose'}">${won ? '+' : '−'}${d.amount}</span>`;
      setTimeout(() => {
        delete row.dataset.flipping;
        if (state && !hasLeft) renderSideBets(); // restore (the challenge is now gone)
      }, 2200);
    }, 1300);
  }
  if (involvedMe) {
    const won = d.winnerId === me.id;
    const opp = d.fromId === me.id ? d.toName : d.fromName;
    // Wait for the coin to land before announcing the outcome.
    setTimeout(() => {
      showToast(`🪙 You ${won ? 'won' : 'lost'} ${d.amount} ${won ? 'from' : 'to'} ${opp}!`, won ? 'win' : 'lose');
    }, 1300);
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

  const mid = state.minigame?.id;
  const typing = mid === 'typeRace'; // the only minigame that doesn't use the canvas
  $('typeRace').classList.toggle('hidden', !typing);
  $('gameCanvas').classList.toggle('hidden', typing);
  $('playHint').classList.toggle('hidden', typing);
  $('gameScores').classList.toggle('hidden', !( mid === 'coinRush')); // others show scores on-canvas
  if (mid === 'suika') $('playHint').innerHTML = 'Move the mouse to aim · <kbd>Click</kbd> or <kbd>Space</kbd> to drop';
  else if (mid === 'trapdoor') $('playHint').innerHTML = '<kbd>Click</kbd> a tile to stand on it — get off the ones about to drop!';
  else if (mid === 'coinRush') $('playHint').innerHTML = '<kbd>WASD</kbd>/arrows move · <kbd>Space</kbd> lunge · <kbd>Click</kbd> shoot (slows them)';
  else if (mid === 'lightcycle') $('playHint').innerHTML = 'Steer with <kbd>WASD</kbd> / arrows — box them in, don\'t crash!';

  if (typing) setupTypeRace(amSpectator || amFolded);
  else startRenderLoop(); // Coin Rush, Fruit Drop, Trapdoor all draw via the rAF loop
}

// ---- Type Race -------------------------------------------------------------
const typeMatchLen = (typed, target) => {
  let i = 0; const n = Math.min(typed.length, target.length);
  while (i < n && typed[i] === target[i]) i++;
  return i;
};

// Once per typing round: clear the box, focus it (players only), reset lanes.
function setupTypeRace(readOnly) {
  if (typingStarted) return;
  typingStarted = true;
  const input = $('typeInput');
  input.value = '';
  input.disabled = !!readOnly;
  input.placeholder = readOnly ? 'Spectating…' : 'Type here…';
  currentParagraph = '';               // re-render the paragraph on the next tick
  typeLanes.forEach((el) => el.remove());
  typeLanes.clear();
  $('typeParagraph').innerHTML = '';
  if (!readOnly) setTimeout(() => input.focus(), 30);
}

// Update timer + slug positions from each authoritative tick.
function renderTypeRace(frame) {
  if (frame.paragraph && frame.paragraph !== currentParagraph) {
    currentParagraph = frame.paragraph;
    renderParagraph($('typeInput').value || '');
  }
  $('gameTimer').textContent = `${frame.timeLeft}s`;

  const track = $('raceTrack');
  const ids = new Set(frame.players.map((p) => p.id));
  for (const p of frame.players) {
    let lane = typeLanes.get(p.id);
    if (!lane) {
      lane = document.createElement('div');
      lane.className = 'lane';
      lane.innerHTML = `<div class="slug-trail"></div><div class="slug-wrap"><span class="slug-name"></span>${slugSVG(colorFor(p.id))}</div>`;
      typeLanes.set(p.id, lane);
      track.appendChild(lane);
    }
    const pct = frame.finishLine ? Math.min(1, p.progress / frame.finishLine) : 0;
    // 56px ≈ slug width; at 100% the slug's nose reaches the finish line.
    lane.querySelector('.slug-wrap').style.left = `calc((100% - 56px) * ${pct.toFixed(4)})`;
    const trail = lane.querySelector('.slug-trail');
    trail.style.width = `calc((100% - 56px) * ${pct.toFixed(4)} + 30px)`; // glistening slime trail
    trail.style.background = `linear-gradient(90deg, ${colorFor(p.id)}00, ${colorFor(p.id)}66)`;
    lane.querySelector('.slug-name').textContent = p.name + (p.id === me.id ? ' (you)' : '');
    lane.classList.toggle('finished', p.finished);
    lane.classList.toggle('me', p.id === me.id);
  }
  for (const [id, el] of typeLanes) if (!ids.has(id)) { el.remove(); typeLanes.delete(id); }

  const meF = frame.players.find((p) => p.id === me.id);
  $('typeStatus').textContent = meF
    ? (meF.finished ? `🏁 Finished — ${meF.wpm} WPM!` : `${meF.wpm} WPM`)
    : '';
}

// Highlight the paragraph: correct part, the error/cursor spot, then the rest.
function renderParagraph(typed) {
  const para = currentParagraph;
  if (!para) { $('typeParagraph').innerHTML = ''; return; }
  const correct = typeMatchLen(typed, para);
  const hasError = typed.length > correct;
  $('typeParagraph').innerHTML =
    `<span class="tp-ok">${escape(para.slice(0, correct))}</span>` +
    `<span class="${hasError ? 'tp-err' : 'tp-cursor'}">${escape(para.slice(correct, correct + 1))}</span>` +
    `<span class="tp-rest">${escape(para.slice(correct + 1))}</span>`;
}

// A shiny, shaded colored slug facing the finish line.
function slugSVG(color) {
  const id = 'sg' + color.replace('#', '');
  const lite = lighten(color, 0.45);
  return `<svg class="slug" viewBox="0 0 64 30" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${lite}"/><stop offset="1" stop-color="${color}"/></linearGradient></defs>
    <ellipse cx="26" cy="21" rx="24" ry="8.5" fill="url(#${id})" stroke="#3a2a18" stroke-width="2"/>
    <circle cx="48" cy="16" r="9.5" fill="url(#${id})" stroke="#3a2a18" stroke-width="2"/>
    <ellipse cx="20" cy="18.5" rx="14" ry="3" fill="#fff" opacity="0.3"/>
    <ellipse cx="46" cy="12.5" rx="4" ry="2.4" fill="#fff" opacity="0.45"/>
    <line x1="52" y1="9" x2="56" y2="2" stroke="#3a2a18" stroke-width="2"/>
    <circle cx="56.5" cy="2" r="2.1" fill="url(#${id})" stroke="#3a2a18" stroke-width="1.5"/>
    <line x1="46" y1="8" x2="48" y2="1.5" stroke="#3a2a18" stroke-width="2"/>
    <circle cx="48" cy="1.5" r="2.1" fill="url(#${id})" stroke="#3a2a18" stroke-width="1.5"/>
    <circle cx="50.5" cy="16" r="1.9" fill="#3a2a18"/>
    <circle cx="51.1" cy="15.3" r="0.6" fill="#fff"/>
  </svg>`;
}

// Send keystrokes to the server (which scores the correct prefix). No pasting.
$('typeInput').addEventListener('input', () => {
  if (state?.phase !== 'playing' || state.minigame?.id !== 'typeRace') return;
  const typed = $('typeInput').value;
  renderParagraph(typed);
  socket.emit('input:type', typed);
});
$('typeInput').addEventListener('paste', (e) => e.preventDefault());

// ---- Fruit Drop (Suika) — cached sprites, glassy jars, interpolated + juicy ---
function fitBoard(x, y, maxW, maxH, board) {
  const ar = board.w / board.h;
  let w = maxW, h = w / ar;
  if (h > maxH) { h = maxH; w = h * ar; }
  return { x: x + (maxW - w) / 2, y: y + (maxH - h) / 2, w, h, scale: w / board.w };
}

function roundRectPath(x, y, w, h, r, g = ctx) { // shared; `g` lets sprites use their own ctx
  g.beginPath();
  if (g.roundRect) { g.roundRect(x, y, w, h, r); return; }
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// Blit the cached Coin Rush ball sprite at an arbitrary radius (shared icon look).
function drawBall(cx, cy, r, color) {
  const s = ballSprite(color), k = r / BALL_R;
  ctx.drawImage(s, cx - s._cx * k, cy - s._cy * k, s._lw * k, s._lh * k);
}
function withinRect(x, y, r) { return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

function suikaBackdrop() {
  const g = ctx.createLinearGradient(0, 0, 0, arenaH);
  g.addColorStop(0, '#2a1d12'); g.addColorStop(1, '#180f08');
  ctx.fillStyle = g; ctx.fillRect(0, 0, arenaW, arenaH);
}

// A glossy fruit pre-rendered once per (type, pixel density). Built at the
// largest size we'll draw it, then blitted scaled down — so it stays crisp.
function fruitSprite(type) {
  const key = type + '@' + SS;
  let sp = fruitSprites.get(key);
  if (sp) return sp;
  const cssR = Math.ceil((suikaRadii ? suikaRadii[type] : 30) * 1.7);
  const size = cssR * 2 + 6, col = FRUIT_COLORS[type % FRUIT_COLORS.length];
  sp = sprite(size, size, (g) => {
    const c = size / 2;
    const grad = g.createRadialGradient(c - cssR * 0.38, c - cssR * 0.42, cssR * 0.15, c, c, cssR);
    grad.addColorStop(0, lighten(col, 0.62)); grad.addColorStop(0.6, col); grad.addColorStop(1, col);
    g.beginPath(); g.arc(c, c, cssR, 0, Math.PI * 2); g.fillStyle = grad; g.fill();
    g.lineWidth = Math.max(1.5, cssR * 0.05); g.strokeStyle = 'rgba(40,26,12,0.5)'; g.stroke();
    g.beginPath(); g.ellipse(c - cssR * 0.32, c - cssR * 0.36, cssR * 0.34, cssR * 0.2, -0.6, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.fill();
  });
  sp._cssR = cssR; sp._size = size;
  fruitSprites.set(key, sp);
  return sp;
}
function drawFruitSprite(cx, cy, dr, type) {
  const sp = fruitSprite(type), ds = sp._size * (dr / sp._cssR);
  ctx.drawImage(sp, cx - ds / 2, cy - ds / 2, ds, ds);
}

// When a jar's score jumps, a merge happened — sparkle the new (merged) fruit.
function detectSuikaMerges(p, rect, s) {
  const prev = suikaPrevScore.get(p.id) || 0;
  if (p.score > prev) {
    const prevIds = suikaPrevIds.get(p.id);
    for (const f of p.fruits) {
      if (prevIds && !prevIds.has(f.id)) {
        spawnBurst(rect.x + f.x * s, rect.y + f.y * s, lighten(FRUIT_COLORS[f.type % FRUIT_COLORS.length], 0.4),
          10, { speed: 95, life: 0.5, size: Math.max(2, suikaRadii[f.type] * s * 0.12) });
      }
    }
  }
  suikaPrevScore.set(p.id, p.score);
  suikaPrevIds.set(p.id, new Set(p.fruits.map((f) => f.id)));
}

function drawJarI(rect, latest, p, ictx, interactive) {
  const board = latest.board, radii = latest.radii, s = rect.scale;
  roundRectPath(rect.x, rect.y, rect.w, rect.h, 14);
  const jg = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.h);
  jg.addColorStop(0, p.toppedOut ? '#3a2a1c' : '#2c1e14'); jg.addColorStop(1, p.toppedOut ? '#241810' : '#160e07');
  ctx.fillStyle = jg; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = p.id === me.id ? '#f3b54b' : '#5b4632'; ctx.stroke();

  ctx.save(); roundRectPath(rect.x, rect.y, rect.w, rect.h, 14); ctx.clip();
  const dy = rect.y + board.dangerY * s;
  ctx.strokeStyle = 'rgba(232,128,111,0.5)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
  ctx.beginPath(); ctx.moveTo(rect.x, dy); ctx.lineTo(rect.x + rect.w, dy); ctx.stroke(); ctx.setLineDash([]);

  const prevMap = ictx.prevBoards.get(p.id);
  for (const f of p.fruits) {
    const pf = prevMap && prevMap.get(f.id);
    const fx = (ictx.hasF1 && pf) ? pf.x + (f.x - pf.x) * ictx.alpha : f.x;
    const fy = (ictx.hasF1 && pf) ? pf.y + (f.y - pf.y) * ictx.alpha : f.y;
    drawFruitSprite(rect.x + fx * s, rect.y + fy * s, radii[f.type] * s, f.type);
  }
  if (interactive && !p.toppedOut) {
    const cx = rect.x + p.aimX * s, cy = rect.y + board.dropY * s;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.setLineDash([4, 6]);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, rect.y + rect.h); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 0.95; drawFruitSprite(cx, cy, radii[p.current] * s, p.current); ctx.globalAlpha = 1;
  }
  // glassy vertical highlight
  ctx.globalAlpha = 0.05; ctx.fillStyle = '#fff';
  ctx.fillRect(rect.x + rect.w * 0.08, rect.y, rect.w * 0.13, rect.h);
  ctx.globalAlpha = 1;
  ctx.restore();

  detectSuikaMerges(p, rect, s);

  if (p.toppedOut) {
    ctx.fillStyle = 'rgba(20,12,6,0.5)'; roundRectPath(rect.x, rect.y, rect.w, rect.h, 14); ctx.fill();
    ctx.fillStyle = '#e8806f'; ctx.font = `bold ${Math.round(rect.w / 6)}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('OUT', rect.x + rect.w / 2, rect.y + rect.h / 2); ctx.textBaseline = 'alphabetic';
  }
  ctx.fillStyle = p.id === me.id ? '#f3b54b' : '#f3e9da';
  ctx.font = `bold ${Math.max(11, Math.round(rect.w / 19))}px system-ui`; ctx.textAlign = 'center';
  ctx.fillText(`${p.name} — ${p.score}`, rect.x + rect.w / 2, rect.y - 7);
  if (interactive) {
    ctx.font = '11px system-ui'; ctx.textAlign = 'right'; ctx.fillStyle = '#b8a890';
    ctx.fillText('next', rect.x + rect.w - 24, rect.y - 9);
    drawFruitSprite(rect.x + rect.w - 11, rect.y - 13, (radii[p.next] || 12) * (rect.w / board.w) * 0.6, p.next);
  }
}

function layoutBoardsI(list, latest, ictx, x, y, w, h) {
  if (!list.length) return;
  const cols = list.length <= 1 ? 1 : list.length <= 4 ? 2 : 3;
  const rows = Math.ceil(list.length / cols);
  const cw = w / cols, ch = h / rows;
  list.forEach((p, i) => {
    const cx = x + (i % cols) * cw, cy = y + Math.floor(i / cols) * ch;
    drawJarI(fitBoard(cx + 6, cy + 18, cw - 12, ch - 30, latest.board), latest, p, ictx, false);
  });
}

// rAF-driven render: interpolate fruit positions between the two buffered
// snapshots (smooth fall/settle), plus merge sparkles.
function drawSuikaFrame(f0, f1, alpha) {
  ensureCanvas(900, 560);
  const now = performance.now();
  const dt = lastFrameT ? Math.min(0.05, (now - lastFrameT) / 1000) : 0;
  lastFrameT = now;
  const latest = f1 || f0;
  suikaRadii = latest.radii;
  $('gameTimer').textContent = `${latest.timeLeft}s`;

  ctx.clearRect(0, 0, arenaW, arenaH);
  suikaBackdrop();
  const ictx = {
    alpha, hasF1: !!f1,
    prevBoards: new Map(f0.players.map((bp) => [bp.id, new Map(bp.fruits.map((fr) => [fr.id, fr]))])),
  };
  const meP = latest.players.find((p) => p.id === me.id);
  const others = latest.players.filter((p) => p.id !== me.id);
  if (meP) {
    const rect = fitBoard(34, 46, 360, 470, latest.board);
    localBoardRect = rect;
    drawJarI(rect, latest, meP, ictx, true);
    layoutBoardsI(others, latest, ictx, 420, 46, 446, 470);
  } else {
    localBoardRect = null;
    layoutBoardsI(latest.players, latest, ictx, 30, 46, 840, 470);
  }
  drawParticles(dt);
}

// ---- Trapdoor --------------------------------------------------------------
function trapBackdrop() { // tiles sit over a dark pit
  const g = ctx.createLinearGradient(0, 0, 0, arenaH);
  g.addColorStop(0, '#2a2238'); g.addColorStop(1, '#100b18');
  ctx.fillStyle = g; ctx.fillRect(0, 0, arenaW, arenaH);
}

function tileSprite() { // a wooden tile, pre-rendered once per pixel density
  if (tileSpr && tileSpr._ss === SS) return tileSpr;
  const sz = 120, rad = 14;
  tileSpr = sprite(sz, sz, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, sz);
    grad.addColorStop(0, '#dcb978'); grad.addColorStop(1, '#a9824a');
    roundRectPath(2, 2, sz - 4, sz - 4, rad, g); g.fillStyle = grad; g.fill();
    roundRectPath(8, 8, sz - 16, sz * 0.3, rad - 6, g); g.fillStyle = 'rgba(255,255,255,0.18)'; g.fill();
    roundRectPath(8, sz * 0.66, sz - 16, sz * 0.28, rad - 6, g); g.fillStyle = 'rgba(60,40,20,0.16)'; g.fill();
    roundRectPath(2, 2, sz - 4, sz - 4, rad, g); g.lineWidth = 3.5; g.strokeStyle = '#5b4632'; g.stroke();
    g.strokeStyle = 'rgba(90,66,40,0.22)'; g.lineWidth = 1.6;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(12, sz * i / 4); g.lineTo(sz - 12, sz * i / 4 + (i % 2 ? 4 : -4)); g.stroke(); }
  });
  tileSpr._ss = SS;
  return tileSpr;
}
function drawTileImg(x, y, sz, rot, alpha) {
  const sp = tileSprite();
  ctx.save(); ctx.globalAlpha = alpha;
  if (rot) { ctx.translate(x + sz / 2, y + sz / 2); ctx.rotate(rot); ctx.drawImage(sp, -sz / 2, -sz / 2, sz, sz); }
  else ctx.drawImage(sp, x, y, sz, sz);
  ctx.restore();
}

// rAF-driven: redraws at refresh rate, with elimination puffs.
function drawTilesFrame(frame) {
  ensureCanvas(900, 560);
  const now = performance.now();
  const dt = lastFrameT ? Math.min(0.05, (now - lastFrameT) / 1000) : 0;
  lastFrameT = now;
  ctx.clearRect(0, 0, arenaW, arenaH);
  trapBackdrop();
  const { cols, rows, tiles, sub, subLeft, subMax } = frame;

  // Status banner.
  const alive = frame.players.filter((p) => !p.eliminated).length;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = "700 26px 'Caveat', cursive";
  ctx.fillStyle = sub === 'falling' ? '#e8806f' : sub === 'done' ? '#86c98a' : '#f3b54b';
  ctx.fillText(sub === 'choose' ? `Pick a safe tile — ${Math.ceil(subLeft)}s`
    : sub === 'falling' ? '⬇  TILES DROPPING!' : 'Round over', arenaW / 2, 34);
  ctx.font = "600 15px 'Patrick Hand', system-ui"; ctx.fillStyle = '#b8a890';
  // No fixed number of drops any more — it runs until one player is left.
  ctx.fillText(`Drop ${frame.fallsDone + (sub === 'falling' ? 1 : 0)}   ·   ${alive} standing`, arenaW / 2, 54);
  $('gameTimer').textContent = sub === 'choose' ? `${Math.ceil(subLeft)}s` : '';

  const area = { x: 24, y: 70, w: arenaW - 48, h: arenaH - 86 };
  const cell = Math.min(area.w / cols, area.h / rows);
  const ox = area.x + (area.w - cell * cols) / 2, oy = area.y + (area.h - cell * rows) / 2;
  const pad = Math.max(4, cell * 0.06);
  tileRects = [];
  const fallProg = sub === 'falling' && subMax ? Math.min(1, 1 - subLeft / subMax) : 0;
  const fallDy = fallProg * fallProg * 380;

  for (let i = 0; i < tiles.length; i++) {
    const x = ox + (i % cols) * cell + pad, y = oy + Math.floor(i / cols) * cell + pad, s = cell - pad * 2;
    tileRects.push({ x, y, w: s, h: s });
    if (tiles[i] === 0) { // hole
      roundRectPath(x, y, s, s, 7); ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fill();
      continue;
    }
    if (tiles[i] === 2) drawTileImg(x, y + fallDy, s, ((i % cols) % 2 ? 1 : -1) * fallProg * 0.4, 1 - fallProg);
    else drawTileImg(x, y, s, 0, 1);
  }

  // Player icons (shaded balls), clustered when several share a tile.
  const byTile = new Map();
  for (const p of frame.players) {
    if (p.eliminated || p.tile == null) continue;
    if (!byTile.has(p.tile)) byTile.set(p.tile, []);
    byTile.get(p.tile).push(p);
  }
  for (const [tile, list] of byTile) {
    const rect = tileRects[tile]; if (!rect) continue;
    const dy = tiles[tile] === 2 ? fallDy : 0;
    const cx = rect.x + rect.w / 2, cy = rect.y + dy + rect.h / 2, ir = Math.min(17, rect.w * 0.24);
    ctx.save(); if (tiles[tile] === 2) ctx.globalAlpha = 1 - fallProg;
    list.forEach((p, k) => {
      const off = list.length === 1 ? { x: 0, y: 0 } : { x: (k % 2 ? 1 : -1) * ir * 0.7, y: (k < 2 ? -1 : 1) * ir * 0.7 };
      const px = cx + off.x, py = cy + off.y;
      drawBall(px, py, ir, colorFor(p.id));
      if (p.id === me.id) { ctx.beginPath(); ctx.arc(px, py, ir + 1.5, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke(); }
      ctx.fillStyle = '#241811'; ctx.font = `700 ${Math.round(ir)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(initials(p.name), px, py + 1); ctx.textBaseline = 'alphabetic';
    });
    ctx.restore();
  }

  // Elimination puffs: when a player drops out, burst debris in their color.
  for (const p of frame.players) {
    if (p.eliminated && !trapPrevElim.has(p.id)) {
      const rect = tileRects[trapPrevTile.get(p.id)];
      if (rect) spawnBurst(rect.x + rect.w / 2, rect.y + rect.h / 2, colorFor(p.id), 16,
        { speed: 150, life: 0.6, size: Math.max(2, rect.w * 0.06), g: 240 });
    }
    if (p.eliminated) trapPrevElim.add(p.id);
    if (p.tile != null) trapPrevTile.set(p.id, p.tile);
  }
  drawParticles(dt);
}

// ---- Lightcycles (Tron) renderer ------------------------------------------
function hexA(hex, a) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// Grid layout: fit the cols×rows board inside the arena with a wall margin.
function tronLayout(frame) {
  const M = 26;
  const cell = Math.floor(Math.min((arenaW - 2 * M) / frame.cols, (arenaH - 2 * M) / frame.rows));
  const gw = cell * frame.cols, gh = cell * frame.rows;
  return { ox: Math.round((arenaW - gw) / 2), oy: Math.round((arenaH - gh) / 2), cell, gw, gh };
}

// rAF-driven: dark neon grid, accumulated trails, glowing heads, crash bursts.
function drawLightcycleFrame(frame) {
  ensureCanvas(900, 560);
  const now = performance.now();
  const dt = lastFrameT ? Math.min(0.05, (now - lastFrameT) / 1000) : 0;
  lastFrameT = now;
  const { ox, oy, cell, gw, gh } = tronLayout(frame);

  // Backdrop: deep blue-black with a faint Tron grid and a neon wall.
  ctx.fillStyle = '#080a14'; ctx.fillRect(0, 0, arenaW, arenaH);
  ctx.strokeStyle = 'rgba(80,120,210,0.10)'; ctx.lineWidth = 1; ctx.beginPath();
  for (let i = 0; i <= frame.cols; i++) { ctx.moveTo(ox + i * cell, oy); ctx.lineTo(ox + i * cell, oy + gh); }
  for (let j = 0; j <= frame.rows; j++) { ctx.moveTo(ox, oy + j * cell); ctx.lineTo(ox + gw, oy + j * cell); }
  ctx.stroke();
  ctx.save();
  ctx.strokeStyle = '#46c8ff'; ctx.lineWidth = 3; ctx.shadowColor = '#46c8ff'; ctx.shadowBlur = 10;
  ctx.strokeRect(ox - 1.5, oy - 1.5, gw + 3, gh + 3);
  ctx.restore();

  // Accumulated trails — one filled cell each, slightly inset so they read as a ribbon.
  const inset = Math.max(0, cell * 0.08);
  for (const t of trailCells) {
    ctx.fillStyle = t.color;
    ctx.fillRect(ox + t.x * cell + inset, oy + t.y * cell + inset, cell - inset * 2, cell - inset * 2);
  }

  // Riders: fill the current cell (so the trail stays connected) + a glowing head.
  for (const c of frame.cycles) {
    const color = colorFor(c.id);
    if (c.alive) {
      ctx.fillStyle = color;
      ctx.fillRect(ox + c.x * cell + inset, oy + c.y * cell + inset, cell - inset * 2, cell - inset * 2);
      // Head slides from its cell toward the next over the step (frame.progress).
      const hx = ox + (c.x + c.dir.x * frame.progress + 0.5) * cell;
      const hy = oy + (c.y + c.dir.y * frame.progress + 0.5) * cell;
      ctx.beginPath(); ctx.arc(hx, hy, cell * 0.95, 0, Math.PI * 2); ctx.fillStyle = hexA(color, 0.28); ctx.fill();
      ctx.beginPath(); ctx.arc(hx, hy, cell * 0.5, 0, Math.PI * 2); ctx.fillStyle = lighten(color, 0.55); ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
      // Name tag above the head.
      ctx.font = "600 13px 'Patrick Hand', system-ui"; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = c.id === me.id ? '#fff' : '#cdd8ee';
      ctx.fillText(c.name + (c.id === me.id ? ' (you)' : ''), hx, hy - cell * 1.1);
    }
    // Crash burst the moment a rider blinks out.
    const wasAlive = tronPrevAlive.has(c.id);
    if (!c.alive && wasAlive) {
      spawnBurst(ox + (c.x + 0.5) * cell, oy + (c.y + 0.5) * cell, lighten(color, 0.3), 28,
        { speed: 220, life: 0.7, size: Math.max(2, cell * 0.16), g: 40 });
      tronPrevAlive.delete(c.id);
    }
    if (c.alive) tronPrevAlive.add(c.id);
  }

  // Status: riders left + the countdown.
  const left = frame.cycles.filter((c) => c.alive).length;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = "700 22px 'Caveat', cursive"; ctx.fillStyle = '#9fd4ff';
  ctx.fillText(`${left} rider${left === 1 ? '' : 's'} left`, arenaW / 2, oy - 8);
  $('gameTimer').textContent = `${frame.timeLeft}s`;

  drawParticles(dt);
}

const canvas = $('gameCanvas');
const ctx = canvas.getContext('2d');

// ---- Coin Rush renderer ----------------------------------------------------
// Sprites (background, coins, player balls) are pre-rendered once to offscreen
// canvases and blitted each frame, so we get rich gradients/shadows cheaply.
// We also render at the display's pixel density (supersampled) for crispness.
let arenaW = 900, arenaH = 560;   // logical arena size (independent of pixels)
let SS = 1;                       // supersample factor (≈ devicePixelRatio)
let bgCanvas = null;              // pre-rendered arena floor
let coinSprite = null;            // pre-rendered coin
const ballSprites = new Map();    // color -> pre-rendered player ball
let particles = [];               // transient sparkles (pickups, hits, trails)
let lastFrameT = 0;
const prevScore = new Map();      // detect coin pickups (score went up)
const prevSlow = new Set();       // detect new hits (became slowed)
const prevBulletIds = new Set();  // detect new shots (muzzle flash)

function makeOffscreen(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
  return c;
}
// Draw a sprite at supersampled resolution but addressed in logical units.
function sprite(lw, lh, draw) {
  const c = makeOffscreen(lw * SS, lh * SS);
  const g = c.getContext('2d');
  g.scale(SS, SS);
  draw(g);
  return c;
}
function lighten(hex, amt) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  let r = (n >> 16) & 255, gr = (n >> 8) & 255, b = n & 255;
  r = Math.round(r + (255 - r) * amt); gr = Math.round(gr + (255 - gr) * amt); b = Math.round(b + (255 - b) * amt);
  return `rgb(${r},${gr},${b})`;
}

// Size the canvas to the arena (crisp for the display) and (re)build sprites.
function ensureCanvas(w, h) {
  const ss = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  if (arenaW === w && arenaH === h && SS === ss && bgCanvas) return;
  arenaW = w; arenaH = h; SS = ss;
  canvas.width = w * SS; canvas.height = h * SS;
  ctx.setTransform(SS, 0, 0, SS, 0, 0); // draw everything in logical coords
  buildBackground(w, h);
  buildCoinSprite();
  ballSprites.clear();
}

function buildBackground(w, h) {
  bgCanvas = sprite(w, h, (b) => {
    const floor = b.createRadialGradient(w / 2, h * 0.42, 40, w / 2, h / 2, Math.max(w, h) * 0.72);
    floor.addColorStop(0, '#3c5733'); floor.addColorStop(1, '#22381d');
    b.fillStyle = floor; b.fillRect(0, 0, w, h);
    b.strokeStyle = 'rgba(255,255,255,0.04)'; b.lineWidth = 1; b.beginPath();
    for (let x = 45; x < w; x += 45) { b.moveTo(x, 0); b.lineTo(x, h); }
    for (let y = 45; y < h; y += 45) { b.moveTo(0, y); b.lineTo(w, y); }
    b.stroke();
    const vig = b.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.62);
    vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.42)');
    b.fillStyle = vig; b.fillRect(0, 0, w, h);
  });
}

const COIN_R = 11, COIN_PAD = 7;
function buildCoinSprite() {
  const size = (COIN_R + COIN_PAD) * 2;
  coinSprite = sprite(size, size, (g) => {
    const c = size / 2;
    const grad = g.createRadialGradient(c - 3, c - 3, 1, c, c, COIN_R);
    grad.addColorStop(0, '#fff3c0'); grad.addColorStop(0.55, '#ffcd3c'); grad.addColorStop(1, '#d28e1f');
    g.beginPath(); g.arc(c, c, COIN_R, 0, Math.PI * 2); g.fillStyle = grad; g.fill();
    g.lineWidth = 2; g.strokeStyle = '#a8690f'; g.stroke();
    g.beginPath(); g.arc(c - 3.4, c - 3.6, 2.6, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.85)'; g.fill();
  });
  coinSprite._size = size;
}

const BALL_R = 18, BALL_PAD = 9;
function ballSprite(color) {
  let s = ballSprites.get(color);
  if (s) return s;
  const lw = (BALL_R + BALL_PAD) * 2, lh = lw + 5, cx = lw / 2, cy = BALL_PAD + BALL_R;
  s = sprite(lw, lh, (g) => {
    g.beginPath(); g.ellipse(cx, cy + BALL_R + 3, BALL_R * 0.85, BALL_R * 0.38, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.fill();
    const grad = g.createRadialGradient(cx - BALL_R * 0.35, cy - BALL_R * 0.4, BALL_R * 0.2, cx, cy, BALL_R);
    grad.addColorStop(0, lighten(color, 0.55)); grad.addColorStop(1, color);
    g.beginPath(); g.arc(cx, cy, BALL_R, 0, Math.PI * 2); g.fillStyle = grad; g.fill();
    g.lineWidth = 2.5; g.strokeStyle = 'rgba(40,26,12,0.4)'; g.stroke();
    g.beginPath(); g.arc(cx - BALL_R * 0.32, cy - BALL_R * 0.34, BALL_R * 0.28, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.fill();
  });
  s._cx = cx; s._cy = cy; s._lw = lw; s._lh = lh;
  ballSprites.set(color, s);
  return s;
}

function spawnBurst(x, y, color, count, o = {}) {
  const speed = o.speed || 70, life = o.life || 0.5, size = o.size || 3, g = o.g ?? 140, lift = o.lift || 0;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, sp = speed * (0.35 + Math.random() * 0.85);
    particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - lift, life, max: life, color, size, g });
  }
  if (particles.length > 320) particles.splice(0, particles.length - 320);
}

// Diff the newest snapshot to spawn pickup/hit/muzzle bursts.
function detectEvents(f) {
  for (const p of f.players) {
    const prev = prevScore.get(p.id);
    if (prev !== undefined && p.score > prev) spawnBurst(p.x, p.y, '#ffe08a', 9, { speed: 95, life: 0.5, lift: 25 });
    prevScore.set(p.id, p.score);
    if (p.slowed && !prevSlow.has(p.id)) spawnBurst(p.x, p.y, '#9fc6ff', 11, { speed: 80, life: 0.5 });
    if (p.slowed) prevSlow.add(p.id); else prevSlow.delete(p.id);
  }
  const ids = new Set();
  for (const b of (f.projectiles || [])) {
    ids.add(b.id);
    if (!prevBulletIds.has(b.id)) spawnBurst(b.x, b.y, '#ffd9d0', 6, { speed: 60, life: 0.22, size: 2.5, g: 0 });
  }
  prevBulletIds.clear(); ids.forEach((id) => prevBulletIds.add(id));
}

function drawParticles(dt) {
  for (const p of particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt; }
  particles = particles.filter((p) => p.life > 0);
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fillStyle = p.color; ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// Render the arena every animation frame (display refresh rate), interpolating
// between buffered snapshots — decoupling smoothness from the network tick rate.
function startRenderLoop() {
  if (rafId) return;          // already running
  snapshots.length = 0;       // fresh buffer for this minigame
  particles = [];
  prevScore.clear(); prevSlow.clear(); prevBulletIds.clear();
  suikaPrevScore.clear(); suikaPrevIds.clear();
  trapPrevTile.clear(); trapPrevElim.clear();
  trailCells = []; tronPrevAlive.clear();
  lastFrameT = 0;
  rafId = requestAnimationFrame(renderLoop);
}
function renderLoop() {
  if (state?.phase !== 'playing') { rafId = null; return; }
  drawGame();
  rafId = requestAnimationFrame(renderLoop);
}

// Scores + timer come straight from the latest snapshot (no need to smooth).
function updateGameHud(f) {
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
}

function drawGame() {
  if (!snapshots.length) return;
  // Trapdoor isn't interpolated — it just redraws the latest frame (for particles).
  const latest = snapshots[snapshots.length - 1].frame;
  if (latest.mode === 'tiles') { drawTilesFrame(latest); return; }
  if (latest.mode === 'tron') { drawLightcycleFrame(latest); return; }

  // Find the two snapshots straddling our (slightly delayed) render time.
  const renderT = performance.now() - RENDER_DELAY;
  let s0 = null, s1 = null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].t <= renderT) { s0 = snapshots[i]; s1 = snapshots[i + 1] || null; break; }
  }
  if (!s0) s0 = snapshots[snapshots.length - 1] || null; // not enough history yet
  if (!s0) return;

  const f0 = s0.frame;
  const f1 = s1 ? s1.frame : null;
  const span = f1 ? s1.t - s0.t : 0;
  const alpha = span > 0 ? Math.min(1, Math.max(0, (renderT - s0.t) / span)) : 0;
  if (f0.mode === 'suika') drawSuikaFrame(f0, f1, alpha);
  else drawFrame(f0, f1, alpha); // Coin Rush
}

function drawFrame(f0, f1, alpha) {
  ensureCanvas(f0.arena.width, f0.arena.height);
  const now = performance.now();
  const dt = lastFrameT ? Math.min(0.05, (now - lastFrameT) / 1000) : 0;
  lastFrameT = now;

  ctx.clearRect(0, 0, arenaW, arenaH);
  ctx.drawImage(bgCanvas, 0, 0, arenaW, arenaH);

  // Coins (latest positions, gentle bob).
  const cs = coinSprite._size;
  for (const c of (f1 || f0).coins) {
    const bob = Math.sin(now / 320 + c.id * 1.7) * 2;
    ctx.drawImage(coinSprite, c.x - cs / 2, c.y - cs / 2 + bob, cs, cs);
  }

  // Bullets: interpolate by id (smooth), drawn as glowing shots.
  const prevBullets = new Map((f0.projectiles || []).map((b) => [b.id, b]));
  for (const b of ((f1 || f0).projectiles || [])) {
    const pb = prevBullets.get(b.id);
    const bx = (f1 && pb) ? pb.x + (b.x - pb.x) * alpha : b.x;
    const by = (f1 && pb) ? pb.y + (b.y - pb.y) * alpha : b.y;
    ctx.beginPath(); ctx.arc(bx, by, 9, 0, Math.PI * 2); ctx.fillStyle = 'rgba(232,128,111,0.35)'; ctx.fill();
    ctx.beginPath(); ctx.arc(bx, by, 4.5, 0, Math.PI * 2); ctx.fillStyle = '#ffe2da'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#c2503c'; ctx.stroke();
  }

  drawParticles(dt); // sparkles behind the players

  // Players: glide between the two snapshots; sprite body + status rings + label.
  const prevById = new Map(f0.players.map((p) => [p.id, p]));
  for (const p of (f1 || f0).players) {
    const prev = prevById.get(p.id) || p;
    const x = f1 ? prev.x + (p.x - prev.x) * alpha : p.x;
    const y = f1 ? prev.y + (p.y - prev.y) * alpha : p.y;
    if (p.boosting) {
      ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(243,181,75,0.9)'; ctx.lineWidth = 5; ctx.stroke();
      if (Math.random() < 0.7) particles.push({ x, y, vx: 0, vy: 0, life: 0.32, max: 0.32, color: colorFor(p.id), size: 7, g: 0 });
    }
    if (p.slowed) {
      ctx.beginPath(); ctx.arc(x, y, 24, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(96,165,250,0.85)'; ctx.lineWidth = 4; ctx.stroke();
    }
    const s = ballSprite(colorFor(p.id));
    ctx.drawImage(s, x - s._cx, y - s._cy, s._lw, s._lh);
    if (p.id === me.id) {
      ctx.beginPath(); ctx.arc(x, y, BALL_R + 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
    }
    ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.strokeText(p.name, x, y - 27);
    ctx.fillStyle = '#fff'; ctx.fillText(p.name, x, y - 27);
  }

  // Local player's boost meter (bottom-left of the arena).
  const meP = (f1 || f0).players.find((p) => p.id === me.id);
  if (meP) drawBoostBar(meP.boostCd || 0, (f1 || f0).boostMax || 5);
}

function drawBoostBar(cd, max) {
  const ready = cd <= 0;
  const w = 152, h = 22, x = 14, y = arenaH - 14 - h, r = 11;
  const pill = (ww) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, ww, h, r); else ctx.rect(x, y, ww, h);
  };
  pill(w); ctx.fillStyle = 'rgba(20,12,6,.45)'; ctx.fill();
  const frac = ready ? 1 : Math.max(0, 1 - cd / max);
  if (frac > 0) { pill(Math.max(h, w * frac)); ctx.fillStyle = ready ? '#86c98a' : '#f3b54b'; ctx.fill(); }
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(ready ? '⚡ BOOST · Space' : `⚡ ${cd.toFixed(1)}s`, x + 12, y + h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
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
  // Lightcycles steer on the key-press (one discrete turn), not continuously.
  if (down && !e.repeat && state.minigame?.id === 'lightcycle') {
    socket.emit('input:turn', TURN_DIR[k]);
  }
}
const TURN_DIR = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
window.addEventListener('keydown', (e) => onKey(e, true));
window.addEventListener('keyup', (e) => onKey(e, false));

// Space = lunge. The server enforces the cooldown; we just send the press.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return; // ignore auto-repeat while held
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  if (state?.phase !== 'playing') return;
  e.preventDefault();
  if (state.minigame?.id === 'suika') socket.emit('input:drop'); // Space drops a fruit
  else socket.emit('input:boost');
});

// Left click on the canvas — Fruit Drop: drop into your jar; Coin Rush: shoot.
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || state?.phase !== 'playing') return;
  const mid = state.minigame?.id;
  if (mid === 'suika') {
    const mx = e.offsetX * (900 / canvas.clientWidth), my = e.offsetY * (560 / canvas.clientHeight);
    if (withinRect(mx, my, localBoardRect)) { e.preventDefault(); socket.emit('input:drop'); }
    return;
  }
  if (mid === 'trapdoor') {
    if (!tileRects) return;
    const mx = e.offsetX * (900 / canvas.clientWidth), my = e.offsetY * (560 / canvas.clientHeight);
    const idx = tileRects.findIndex((r) => withinRect(mx, my, r));
    if (idx >= 0) { e.preventDefault(); socket.emit('input:place', idx); } // server ignores non-standing tiles
    return;
  }
  const mp = myPlayer();
  if (!mp || mp.role !== 'player' || state.poker?.folded.includes(me.id)) return; // contenders only
  e.preventDefault();
  // Convert click (display px) into logical arena coordinates.
  const ax = e.offsetX * (arenaW / canvas.clientWidth);
  const ay = e.offsetY * (arenaH / canvas.clientHeight);
  socket.emit('input:shoot', { x: ax, y: ay });
});

// Move the mouse over your jar to aim the held fruit (Fruit Drop).
canvas.addEventListener('mousemove', (e) => {
  if (state?.phase !== 'playing' || state.minigame?.id !== 'suika' || !localBoardRect) return;
  const now = performance.now();
  if (now - lastAimSent < 25) return; // throttle to ~40/s
  const mx = e.offsetX * (900 / canvas.clientWidth), my = e.offsetY * (560 / canvas.clientHeight);
  if (!withinRect(mx, my, localBoardRect)) return;
  lastAimSent = now;
  socket.emit('input:aim', (mx - localBoardRect.x) / localBoardRect.scale);
});

// Send the current movement direction at the simulation rate.
setInterval(() => {
  if (state?.phase !== 'playing') return;
  const dir = {
    x: (keys.right ? 1 : 0) - (keys.left ? 1 : 0),
    y: (keys.down ? 1 : 0) - (keys.up ? 1 : 0),
  };
  socket.emit('input:move', dir);
}, 1000 / 30);

// ---- results ---------------------------------------------------------------
function renderResults() {
  const r = state.result;
  if (!r) return;
  const winner = r.winnerName;
  $('resRound').textContent = r.round;
  $('resWinnerLine').textContent =
    !winner ? 'No winner this round.'
    : r.uncontested ? `🏆 ${winner} took the ${r.pot} pot — everyone else folded!`
    : r.tiebreak ? `🪙 Dead heat — ${winner} won the coin toss and the ${r.pot} pot!`
    : `🏆 ${winner} won ${r.minigame.name} and took the ${r.pot} pot!`;

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
      <span><span class="chip-icon"></span> ${p.bankroll} <span class="${cls}">(${sign}${p.net})</span></span>`;
    list.appendChild(li);
  });

  // Spectators / eliminated players this match.
  for (const s of fs.spectators) {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="rank">—</span>
      <span style="color:${colorFor(s.id)}">${escape(s.name)}</span> <span class="spec-tag">SPECTATED</span></span>
      <span><span class="chip-icon"></span> ${s.bankroll}</span>`;
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

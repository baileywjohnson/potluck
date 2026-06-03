import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { Server } from 'socket.io';
import { Room, makeRoomCode } from './Room.js';
import * as auth from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the static client.
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- room registry ---------------------------------------------------------
const rooms = new Map(); // code -> Room

function createRoom() {
  let code;
  do { code = makeRoomCode(); } while (rooms.has(code));
  const room = new Room(io, code, (c) => rooms.delete(c));
  rooms.set(code, room);
  return room;
}

// Remember which room/seat a socket belongs to on the socket itself, so we
// can route its actions to the right room and player.
function bind(socket, code, playerId) {
  socket.data.roomCode = code;
  socket.data.playerId = playerId;
}

// A logged-in account may occupy only ONE room at a time. Find its current seat
// (if any) across all rooms. Guests (no userId) are unconstrained — they have no
// identity that spans tabs.
function findAccountSeat(userId) {
  for (const room of rooms.values()) {
    for (const player of room.players.values()) {
      if (player.userId && player.userId === userId) return { room, player };
    }
  }
  return null;
}

// Guard for create/join. Returns an error string if the account is *actively*
// (still connected) in another room. A merely disconnected old seat — e.g. they
// closed the tab — is freed so they aren't locked out of starting fresh.
function accountRoomBlock(userId) {
  if (!userId) return null;
  const seat = findAccountSeat(userId);
  if (!seat) return null;
  if (seat.player.connected) return `You're already in room ${seat.room.code}. Leave it there first.`;
  seat.room.removePlayer(seat.player.id); // reclaim the stale seat from a dropped session
  return null;
}

io.on('connection', (socket) => {
  const myRoom = () => rooms.get(socket.data.roomCode);
  const myPid = () => socket.data.playerId;
  // The account (if any) currently authenticated on THIS socket.
  const myAccount = () => (socket.data.userId ? auth.loadAccount(socket.data.userId) : null);

  // --- accounts (optional; guests skip all of this) ---
  socket.on('auth:signup', ({ name, password } = {}, ack) => {
    const res = auth.signup(name, password);
    if (res.ok) { socket.data.userId = res.user.id; socket.data.authToken = res.token; }
    ack?.(res);
  });
  socket.on('auth:login', ({ name, password } = {}, ack) => {
    const res = auth.login(name, password);
    if (res.ok) { socket.data.userId = res.user.id; socket.data.authToken = res.token; }
    ack?.(res);
  });
  socket.on('auth:resume', ({ token } = {}, ack) => {
    const res = auth.resume(token);
    if (res.ok) { socket.data.userId = res.user.id; socket.data.authToken = token; }
    ack?.(res);
  });
  socket.on('auth:logout', (ack) => {
    if (socket.data.authToken) auth.logout(socket.data.authToken);
    socket.data.userId = null; socket.data.authToken = null;
    ack?.({ ok: true });
  });

  // --- joining ---
  socket.on('room:create', ({ name }, ack) => {
    const account = myAccount();
    const blocked = accountRoomBlock(account?.id);
    if (blocked) return ack?.({ ok: false, error: blocked });
    const room = createRoom();
    const player = room.addPlayer(socket, name, account);
    bind(socket, room.code, player.id);
    socket.emit('chat:history', room.chatHistory());
    // The token is the player's private reconnect key — only ever sent here.
    // Return the state too so the client renders immediately (not just on the
    // next broadcast — which may not arrive for a while mid-match).
    ack?.({ ok: true, code: room.code, playerId: player.id, token: player.token, state: room.getPublicState() });
  });

  socket.on('room:join', ({ code, name }, ack) => {
    code = (code || '').toUpperCase().trim();
    // Resolve the account + one-room guard first, so freeing any stale seat
    // can't leave us holding a reference to a room that just got cleaned up.
    const account = myAccount();
    const blocked = accountRoomBlock(account?.id);
    if (blocked) return ack?.({ ok: false, error: blocked });
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: 'Room not found.' });
    if (room.players.size >= 8) return ack?.({ ok: false, error: 'Room is full.' });
    // Joining mid-match is allowed — you spectate this match and play the next.
    const player = room.addPlayer(socket, name, account);
    bind(socket, room.code, player.id);
    socket.emit('chat:history', room.chatHistory());
    ack?.({ ok: true, code: room.code, playerId: player.id, token: player.token, state: room.getPublicState() });
  });

  // Reclaim a seat after a drop or page reload, proven by the secret token.
  socket.on('room:rejoin', ({ code, token }, ack) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: 'Room no longer exists.' });
    const res = room.rejoin(token, socket);
    if (res.error) return ack?.({ ok: false, error: res.error });
    bind(socket, code, res.playerId);
    socket.emit('chat:history', room.chatHistory());
    ack?.({ ok: true, code, playerId: res.playerId, state: room.getPublicState() });
  });

  // --- match control ---
  socket.on('room:setMode', ({ mode, buyIn }) => myRoom()?.setMode(myPid(), mode, buyIn));
  socket.on('room:start', (ack) => {
    const res = myRoom()?.start(myPid());
    ack?.(res || { error: 'Not in a room.' });
  });
  socket.on('room:returnToLobby', () => myRoom()?.returnToLobby(myPid()));

  // Explicitly leave a room (back to the main screen). Frees the seat now
  // rather than waiting out the reconnect grace.
  socket.on('room:leave', () => {
    const room = myRoom();
    const code = socket.data.roomCode;
    if (room) room.removePlayer(myPid());
    if (code) socket.leave(code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
  });

  // --- betting (poker-style turn actions: check/call/bet/raise/fold) ---
  socket.on('poker:action', ({ type }, ack) => {
    const room = myRoom();
    if (!room) return ack?.({ error: 'Not in a room.' });
    ack?.(room.pokerAction(myPid(), type));
  });

  // --- Side Bets (player-vs-player coin flips) ---
  socket.on('sidebet:challenge', ({ targetId, amount }, ack) => {
    const room = myRoom();
    ack?.(room ? room.challengeSideBet(myPid(), targetId, amount) : { error: 'Not in a room.' });
  });
  socket.on('sidebet:respond', ({ id, accept }, ack) => {
    const room = myRoom();
    ack?.(room ? room.respondSideBet(myPid(), id, accept) : { error: 'Not in a room.' });
  });

  // --- gameplay input ---
  socket.on('input:move', (dir) => myRoom()?.handleInput(myPid(), dir));
  socket.on('input:boost', () => myRoom()?.handleAction(myPid(), 'boost'));
  socket.on('input:shoot', (target) => myRoom()?.handleAction(myPid(), 'shoot', target));
  socket.on('input:type', (text) => myRoom()?.handleAction(myPid(), 'type', text));
  socket.on('input:aim', (x) => myRoom()?.handleAction(myPid(), 'aim', x));
  socket.on('input:drop', () => myRoom()?.handleAction(myPid(), 'drop'));
  socket.on('input:place', (idx) => myRoom()?.handleAction(myPid(), 'place', idx));
  socket.on('input:turn', (dir) => myRoom()?.handleAction(myPid(), 'turn', dir));

  // --- chat ---
  socket.on('chat:send', (text) => myRoom()?.postChat(myPid(), text));

  // --- dropping (seat is held open for the grace period) ---
  socket.on('disconnect', () => {
    myRoom()?.markDisconnected(myPid(), socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Potluck running at  http://localhost:${PORT}\n`);
});

import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { Server } from 'socket.io';
import { Room, makeRoomCode } from './Room.js';

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

io.on('connection', (socket) => {
  const myRoom = () => rooms.get(socket.data.roomCode);
  const myPid = () => socket.data.playerId;

  // --- joining ---
  socket.on('room:create', ({ name }, ack) => {
    const room = createRoom();
    const player = room.addPlayer(socket, name);
    bind(socket, room.code, player.id);
    // The token is the player's private reconnect key — only ever sent here.
    // Return the state too so the client renders immediately (not just on the
    // next broadcast — which may not arrive for a while mid-match).
    ack?.({ ok: true, code: room.code, playerId: player.id, token: player.token, state: room.getPublicState() });
  });

  socket.on('room:join', ({ code, name }, ack) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: 'Room not found.' });
    if (room.players.size >= 8) return ack?.({ ok: false, error: 'Room is full.' });
    // Joining mid-match is allowed — you spectate this match and play the next.
    const player = room.addPlayer(socket, name);
    bind(socket, room.code, player.id);
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

  // --- dropping (seat is held open for the grace period) ---
  socket.on('disconnect', () => {
    myRoom()?.markDisconnected(myPid(), socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Potluck running at  http://localhost:${PORT}\n`);
});

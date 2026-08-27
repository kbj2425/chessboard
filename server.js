'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Engine = require('./chessEngine.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
// 클라이언트가 동일한 규칙 엔진으로 이동 가능 칸 미리보기를 계산할 수 있도록 공유 파일 제공
app.get('/chessEngine.js', (req, res) => res.sendFile(path.join(__dirname, 'chessEngine.js')));

// ---------------------------------------------------------------------------
// Render.com 무료 플랜 슬립 방지용 헬스체크 (UptimeRobot 5분 간격 핑 대상)
// ---------------------------------------------------------------------------
app.get('/ping', (req, res) => res.status(200).send('pong'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime(), rooms: rooms.size, users: users.size }));

// ---------------------------------------------------------------------------
// In-memory 저장소 (DB 없음)
// ---------------------------------------------------------------------------
const users = new Map();     // username -> { passwordHash, salt, stats:{w,d,l}, token }
const sessions = new Map();  // token -> username
const inbox = new Map();     // username -> [{id, fromRoomId, fromUsername, mode, ts}]
const rooms = new Map();     // roomId -> room object
const socketUser = new Map(); // socketId -> username
const userSocket = new Map(); // username -> socketId (최신 연결)

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(8).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { hash, salt };
}

function makeToken() { return crypto.randomBytes(24).toString('hex'); }
function makeRoomId() { return crypto.randomBytes(4).toString('hex'); }

function publicUser(username) {
  const u = users.get(username);
  if (!u) return null;
  return { username, stats: u.stats, online: userSocket.has(username) };
}

function roomSummary(room) {
  return {
    id: room.id,
    mode: room.mode,
    timeControl: room.timeControl,
    timeControlKey: room.timeControlKey,
    status: room.status,
    turn: room.state ? room.state.turn : null,
    players: room.players.map((p) => ({ username: p.username, color: p.color, connected: p.connected })),
    spectatorCount: room.spectators.size,
  };
}

function broadcastLobby() {
  const list = [...rooms.values()].map(roomSummary);
  const online = [...userSocket.keys()];
  io.emit('lobby:update', { rooms: list, online });
}

function sendInbox(username) {
  const sid = userSocket.get(username);
  if (sid) io.to(sid).emit('inbox:update', inbox.get(username) || []);
}

// ---------------------------------------------------------------------------
// 시간 제어 프리셋
// ---------------------------------------------------------------------------
const TIME_PRESETS = {
  unlimited: null,
  bullet: { initial: 60 * 1000, increment: 0 },
  blitz5: { initial: 5 * 60 * 1000, increment: 0 },
  rapid10: { initial: 10 * 60 * 1000, increment: 0 },
  classical15: { initial: 15 * 60 * 1000, increment: 3 * 1000 },
};

// ---------------------------------------------------------------------------
// 룸(대국) 생성/관리
// ---------------------------------------------------------------------------
function createRoom(mode, timeControlKey, hostUsername) {
  const id = makeRoomId();
  const tc = TIME_PRESETS[timeControlKey] || null;
  const colors = mode === '4p' ? ['p1', 'p2', 'p3', 'p4'] : ['white', 'black'];
  const room = {
    id,
    mode,
    timeControlKey,
    timeControl: tc,
    state: Engine.createGame(mode),
    players: [],       // {username, color, connected}
    spectators: new Set(), // socketIds
    clocks: {},         // color -> ms remaining
    turnStartedAt: null,
    flagTimer: null,
    status: 'waiting',  // waiting | ongoing | finished
    chat: [],
    teamChat: { white: [], black: [] },
    drawOffer: null,
    takebackRequest: null,
    premoves: {},        // username -> {from,to,promotion}
    createdAt: Date.now(),
    hostUsername,
  };
  colors.forEach((c) => { if (tc) room.clocks[c] = tc.initial; });
  rooms.set(id, room);
  return room;
}

function seatSlots(mode) {
  return mode === '4p' ? 4 : mode === '2v2' ? 4 : 2;
}

function colorForSeat(mode, seatIndex) {
  if (mode === '4p') return ['p1', 'p2', 'p3', 'p4'][seatIndex];
  if (mode === '2v2') return ['white', 'white', 'black', 'black'][seatIndex]; // 팀당 2명
  return ['white', 'black'][seatIndex];
}

function joinRoomAsPlayer(room, username) {
  const existing = room.players.find((p) => p.username === username);
  if (existing) { existing.connected = true; return existing; }
  const slots = seatSlots(room.mode);
  if (room.players.length >= slots) return null;
  const color = colorForSeat(room.mode, room.players.length);
  const p = { username, color, connected: true };
  room.players.push(p);
  if (room.players.length === slots) {
    room.status = 'ongoing';
    startClockForTurn(room);
  }
  return p;
}

function startClockForTurn(room) {
  clearFlagTimer(room);
  room.turnStartedAt = Date.now();
  if (!room.timeControl) return;
  const color = room.state.turn;
  room.flagTimer = setTimeout(() => onFlagFall(room, color), room.clocks[color]);
}

function clearFlagTimer(room) {
  if (room.flagTimer) { clearTimeout(room.flagTimer); room.flagTimer = null; }
}

function onFlagFall(room, color) {
  if (room.state.status !== 'ongoing') return;
  room.state.status = room.mode === '2v2' ? 'teamwin' : 'checkmate';
  if (room.mode === '2v2') {
    room.state.winner = color === 'white' ? 'black' : 'white';
  } else if (room.mode === '4p') {
    room.state.eliminated[color] = true;
    const remaining = ['p1', 'p2', 'p3', 'p4'].filter((c) => !room.state.eliminated[c]);
    room.state.winner = remaining.length === 1 ? remaining[0] : null;
  } else {
    room.state.winner = color === 'white' ? 'black' : 'white';
  }
  room.state.resultReason = '시간 초과';
  finishRoom(room);
}

function applyClockOnMove(room, movedColor) {
  if (!room.timeControl) return;
  const elapsed = Date.now() - room.turnStartedAt;
  room.clocks[movedColor] = Math.max(0, room.clocks[movedColor] - elapsed) + room.timeControl.increment;
}

function finishRoom(room) {
  clearFlagTimer(room);
  room.status = 'finished';
  applyResultsToStats(room);
  io.to(room.id).emit('game:over', { status: room.state.status, winner: room.state.winner, reason: room.state.resultReason });
  broadcastLobby();
}

function applyResultsToStats(room) {
  const st = room.state;
  room.players.forEach((p) => {
    const u = users.get(p.username);
    if (!u) return;
    let outcome = 'draw';
    if (st.status === 'draw' || st.status === 'stalemate') outcome = 'draw';
    else if (st.winner) {
      const won = (room.mode === '4p') ? st.winner === p.color : Engine.teamOf(room.mode, p.color) === st.winner;
      outcome = won ? 'win' : 'loss';
    }
    if (outcome === 'win') u.stats.w += 1;
    else if (outcome === 'loss') u.stats.l += 1;
    else u.stats.d += 1;
  });
}

function clockSnapshot(room) {
  if (!room.timeControl) return null;
  const snap = Object.assign({}, room.clocks);
  if (room.status === 'ongoing' && room.turnStartedAt) {
    const color = room.state.turn;
    const elapsed = Date.now() - room.turnStartedAt;
    snap[color] = Math.max(0, room.clocks[color] - elapsed);
  }
  return snap;
}

function serializeState(room) {
  const st = room.state;
  return {
    mode: st.mode,
    board: [...st.board.entries()],
    valid: [...st.valid],
    width: st.width,
    height: st.height,
    turn: st.turn,
    turnOrder: st.turnOrder,
    eliminated: st.eliminated,
    captured: st.captured,
    status: st.status,
    winner: st.winner,
    resultReason: st.resultReason,
    history: st.history,
    enPassant: st.enPassant,
    clocks: clockSnapshot(room),
    players: room.players,
    roomId: room.id,
    roomStatus: room.status,
    timeControlKey: room.timeControlKey,
    drawOffer: room.drawOffer,
    takebackRequest: room.takebackRequest,
  };
}

function broadcastState(room) {
  io.to(room.id).emit('game:state', serializeState(room));
}

// ---------------------------------------------------------------------------
// 재접속: 미종료 대국 찾기
// ---------------------------------------------------------------------------
function findOngoingRoomsFor(username) {
  return [...rooms.values()].filter(
    (r) => r.status !== 'finished' && r.players.some((p) => p.username === username)
  );
}

function tryPremove(room, username) {
  const pm = room.premoves[username];
  if (!pm) return;
  delete room.premoves[username];
  const player = room.players.find((p) => p.username === username);
  if (!player || player.color !== room.state.turn) return;
  const result = Engine.makeMove(room.state, pm.from, pm.to, pm.promotion);
  if (result.ok) {
    applyClockOnMove(room, result.move.from ? player.color : player.color);
    postMoveHousekeeping(room, result);
  }
}

function postMoveHousekeeping(room, result) {
  room.drawOffer = null;
  room.takebackRequest = null;
  if (room.state.status !== 'ongoing') {
    broadcastState(room);
    finishRoom(room);
    return;
  }
  startClockForTurn(room);
  broadcastState(room);
  // 다음 차례 플레이어의 사전수가 있으면 즉시 시도
  const nextPlayer = room.players.find((p) => p.color === room.state.turn);
  if (nextPlayer && room.premoves[nextPlayer.username]) {
    setTimeout(() => tryPremove(room, nextPlayer.username), 50);
  }
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('auth:register', ({ username, password }, cb) => {
    cb = cb || (() => {});
    username = (username || '').trim();
    if (!username || !password) return cb({ ok: false, error: '아이디와 비밀번호를 입력하세요.' });
    if (users.has(username)) return cb({ ok: false, error: '이미 존재하는 아이디입니다.' });
    const { hash, salt } = hashPassword(password);
    const token = makeToken();
    users.set(username, { passwordHash: hash, salt, stats: { w: 0, d: 0, l: 0 }, token });
    sessions.set(token, username);
    finishLogin(socket, username, token);
    cb({ ok: true, token, username });
  });

  socket.on('auth:login', ({ username, password }, cb) => {
    cb = cb || (() => {});
    username = (username || '').trim();
    const u = users.get(username);
    if (!u) return cb({ ok: false, error: '존재하지 않는 계정입니다.' });
    const { hash } = hashPassword(password, u.salt);
    if (hash !== u.passwordHash) return cb({ ok: false, error: '비밀번호가 올바르지 않습니다.' });
    const token = makeToken();
    u.token = token;
    sessions.set(token, username);
    finishLogin(socket, username, token);
    cb({ ok: true, token, username });
  });

  socket.on('auth:resume', ({ token }, cb) => {
    cb = cb || (() => {});
    const username = sessions.get(token);
    if (!username || !users.has(username)) return cb({ ok: false });
    finishLogin(socket, username, token);
    cb({ ok: true, username, token });
  });

  function finishLogin(socket, username, token) {
    socketUser.set(socket.id, username);
    userSocket.set(username, socket.id);
    socket.data.username = username;
    socket.join('user:' + username);
    if (!inbox.has(username)) inbox.set(username, []);
    const ongoing = findOngoingRoomsFor(username);
    socket.emit('auth:ready', {
      username,
      stats: users.get(username).stats,
      ongoingRooms: ongoing.map(roomSummary),
    });
    sendInbox(username);
    broadcastLobby();
  }

  socket.on('lobby:list', (cb) => {
    cb = cb || (() => {});
    cb({ rooms: [...rooms.values()].map(roomSummary), online: [...userSocket.keys()] });
  });

  socket.on('lobby:createRoom', ({ mode, timeControlKey }, cb) => {
    cb = cb || (() => {});
    const username = socket.data.username;
    if (!username) return cb({ ok: false, error: '로그인이 필요합니다.' });
    if (!['1v1', '2v2', '4p'].includes(mode)) return cb({ ok: false, error: '잘못된 모드입니다.' });
    if (!TIME_PRESETS.hasOwnProperty(timeControlKey)) return cb({ ok: false, error: '잘못된 시간 설정입니다.' });
    const room = createRoom(mode, timeControlKey, username);
    joinRoomAsPlayer(room, username);
    socket.join(room.id);
    broadcastLobby();
    cb({ ok: true, roomId: room.id });
  });

  socket.on('lobby:joinRoom', ({ roomId }, cb) => {
    cb = cb || (() => {});
    const username = socket.data.username;
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: '존재하지 않는 방입니다.' });
    const p = joinRoomAsPlayer(room, username);
    socket.join(room.id);
    if (!p) {
      room.spectators.add(socket.id);
    }
    broadcastState(room);
    broadcastLobby();
    cb({ ok: true, asPlayer: !!p });
  });

  socket.on('lobby:spectate', ({ roomId }, cb) => {
    cb = cb || (() => {});
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: '존재하지 않는 방입니다.' });
    room.spectators.add(socket.id);
    socket.join(room.id);
    broadcastState(room);
    cb({ ok: true });
  });

  socket.on('lobby:invite', ({ toUsername, roomId }, cb) => {
    cb = cb || (() => {});
    const from = socket.data.username;
    if (!users.has(toUsername)) return cb({ ok: false, error: '존재하지 않는 사용자입니다.' });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: '존재하지 않는 방입니다.' });
    const list = inbox.get(toUsername) || [];
    list.push({ id: crypto.randomBytes(4).toString('hex'), fromUsername: from, roomId, mode: room.mode, ts: Date.now() });
    inbox.set(toUsername, list);
    sendInbox(toUsername);
    cb({ ok: true });
  });

  socket.on('inbox:accept', ({ inviteId }, cb) => {
    cb = cb || (() => {});
    const username = socket.data.username;
    const list = inbox.get(username) || [];
    const idx = list.findIndex((i) => i.id === inviteId);
    if (idx === -1) return cb({ ok: false });
    const invite = list.splice(idx, 1)[0];
    inbox.set(username, list);
    sendInbox(username);
    const room = rooms.get(invite.roomId);
    if (!room) return cb({ ok: false, error: '방이 사라졌습니다.' });
    const p = joinRoomAsPlayer(room, username);
    socket.join(room.id);
    if (!p) room.spectators.add(socket.id);
    broadcastState(room);
    broadcastLobby();
    cb({ ok: true, roomId: room.id });
  });

  socket.on('inbox:decline', ({ inviteId }, cb) => {
    cb = cb || (() => {});
    const username = socket.data.username;
    const list = (inbox.get(username) || []).filter((i) => i.id !== inviteId);
    inbox.set(username, list);
    sendInbox(username);
    cb({ ok: true });
  });

  socket.on('game:reconnect', ({ roomId }, cb) => {
    cb = cb || (() => {});
    const room = rooms.get(roomId);
    const username = socket.data.username;
    if (!room || !username) return cb({ ok: false });
    const p = room.players.find((pl) => pl.username === username);
    if (p) p.connected = true;
    socket.join(room.id);
    broadcastState(room);
    cb({ ok: true, isPlayer: !!p });
  });

  socket.on('game:move', ({ roomId, from, to, promotion }, cb) => {
    cb = cb || (() => {});
    const room = rooms.get(roomId);
    const username = socket.data.username;
    if (!room) return cb({ ok: false, error: '방이 없습니다.' });
    const player = room.players.find((p) => p.username === username);
    if (!player) return cb({ ok: false, error: '플레이어가 아닙니다.' });
    if (room.state.turn !== player.color) return cb({ ok: false, error: '내 차례가 아닙니다.' });
    const result = Engine.makeMove(room.state, from, to, promotion);
    if (!result.ok) return cb({ ok: false, error: '불가능한 이동입니다: ' + result.reason });
    applyClockOnMove(room, player.color);
    postMoveHousekeeping(room, result);
    cb({ ok: true });
  });

  socket.on('game:premove', ({ roomId, from, to, promotion }, cb) => {
    cb = cb || (() => {});
    const room = rooms.get(roomId);
    const username = socket.data.username;
    if (!room) return cb({ ok: false });
    room.premoves[username] = { from, to, promotion };
    cb({ ok: true });
  });

  socket.on('game:cancelPremove', ({ roomId }, cb) => {
    cb = cb || (() => {});
    const room = rooms.get(roomId);
    const username = socket.data.username;
    if (room) delete room.premoves[username];
    cb({ ok: true });
  });

  socket.on('game:resign', ({ roomId }, cb) => {
    cb = cb || (() => {});
    const room = rooms.get(roomId);
    const username = socket.data.username;
    const player = room && room.players.find((p) => p.username === username);
    if (!room || !player) return cb({ ok: false });
    if (room.mode === '4p') {
      room.state.eliminated[player.color] = true;
      const remaining = ['p1', 'p2', 'p3', 'p4'].filter((c) => !room.state.eliminated[c]);
      if (remaining.length === 1) {
        room.state.status = 'checkmate';
        room.state.winner = remaining[0];
        room.state.resultReason = '상대 기권';
        finishRoom(room);
      } else if (room.state.turn === player.color) {
        advanceTurnExternally(room);
      }
      broadcastState(room);
    } else {
      room.state.status = room.mode === '2v2' ? 'teamwin' : 'resigned';
      room.state.winner = room.mode === '2v2'
        ? (player.color === 'white' ? 'black' : 'white')
        : (player.color === 'white' ? 'black' : 'white');
      room.state.resultReason = '기권';
      finishRoom(room);
    }
    cb({ ok: true });
  });

  socket.on('game:offerDraw', ({ roomId }, cb) => {
    cb = cb || (() => {});
    const room = rooms.get(roomId);
    const username = socket.data.username;
    if (!room) return cb({ ok: false });
    room.drawOffer = username;
    io.to(room.id).emit('game:drawOffered', { from: username });
    cb({ ok: true });
  });

  socket.on('game:respondDraw', ({ roomId, accept }, cb) => {
    cb = cb || (() => {});
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false });
    room.drawOffer = null;
    if (accept) {
      room.state.status = 'draw';
      room.state.resultReason = '무승부 합의';
      finishRoom(room);
    } else {
      io.to(room.id).emit('game:drawDeclined');
    }
    broadcastState(room);
    cb({ ok: true });
  });

  socket.on('game:requestTakeback', ({ roomId }, cb) => {
    cb = cb || (() => {});
    const room = rooms.get(roomId);
    const username = socket.data.username;
    if (!room) return cb({ ok: false });
    room.takebackRequest = username;
    io.to(room.id).emit('game:takebackRequested', { from: username });
    cb({ ok: true });
  });

  socket.on('game:respondTakeback', ({ roomId, accept }, cb) => {
    cb = cb || (() => {});
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false });
    room.takebackRequest = null;
    if (accept) {
      // 마지막 수를 무르기 위해 초기 상태부터 히스토리를 1수 줄여 재생
      replayWithoutLastMove(room);
      broadcastState(room);
    }
    cb({ ok: true });
  });

  socket.on('chat:send', ({ roomId, message, scope }) => {
    const room = rooms.get(roomId);
    const username = socket.data.username;
    if (!room || !username || !message) return;
    const entry = { username, message: String(message).slice(0, 500), ts: Date.now() };
    if (scope === 'team' && room.mode === '2v2') {
      const player = room.players.find((p) => p.username === username);
      if (!player) return;
      room.teamChat[player.color].push(entry);
      room.players.filter((p) => p.color === player.color).forEach((p) => {
        const sid = userSocket.get(p.username);
        if (sid) io.to(sid).emit('chat:team', entry);
      });
    } else {
      room.chat.push(entry);
      io.to(room.id).emit('chat:all', entry);
    }
  });

  socket.on('disconnect', () => {
    const username = socketUser.get(socket.id);
    socketUser.delete(socket.id);
    if (username && userSocket.get(username) === socket.id) {
      userSocket.delete(username);
    }
    rooms.forEach((room) => {
      room.spectators.delete(socket.id);
      const p = room.players.find((pl) => pl.username === username);
      if (p) p.connected = false;
    });
    broadcastLobby();
  });
});

function advanceTurnExternally(room) {
  // 4인 모드에서 기권한 플레이어의 턴을 건너뛰기 위해 더미 진행
  const st = room.state;
  let next = st.turnIndex;
  for (let i = 0; i < st.turnOrder.length; i++) {
    next = (next + 1) % st.turnOrder.length;
    if (!st.eliminated[st.turnOrder[next]]) break;
  }
  st.turnIndex = next;
  startClockForTurn(room);
}

function replayWithoutLastMove(room) {
  const st = room.state;
  const moves = st.history.slice(0, -1);
  const fresh = Engine.createGame(room.mode);
  moves.forEach((h) => {
    Engine.makeMove(fresh, h.from, h.to, h.promotion || undefined);
  });
  room.state = fresh;
  startClockForTurn(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Clubhouse Chess server listening on port ${PORT}`);
});

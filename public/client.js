(function () {
  'use strict';
  const socket = io();
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const PIECE_GLYPH = {
    K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟',
  };
  const COLOR_LABEL = {
    white: '화이트', black: '블랙', p1: '플레이어 1', p2: '플레이어 2', p3: '플레이어 3', p4: '플레이어 4',
  };
  const MODE_LABEL = { '1v1': '1 vs 1 클래식', '2v2': '2 vs 2 팀 체스', '4p': '4인 자유대전' };

  // -------------------------------------------------------------------
  // 전역 상태
  // -------------------------------------------------------------------
  const app = {
    token: localStorage.getItem('cc_token') || null,
    username: null,
    stats: null,
    room: null,          // 서버가 보낸 최신 serializeState
    myColor: null,
    isSpectator: false,
    selected: null,       // 선택된 square key
    legalTargets: [],      // getLegalMoves 결과
    premove: null,
    dragKey: null,
    clockInterval: null,
    reviewing: false,
    reviewIndex: 0,
    reviewBoard: null,
    sideTab: 'moves',
  };

  // -------------------------------------------------------------------
  // 화면 전환
  // -------------------------------------------------------------------
  function showScreen(id) {
    ['authScreen', 'lobbyScreen', 'gameScreen'].forEach((s) => {
      $('#' + s).hidden = s !== id;
    });
  }

  // -------------------------------------------------------------------
  // 인증
  // -------------------------------------------------------------------
  $all('.tab-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $all('.tab-btn[data-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $('#loginForm').hidden = tab !== 'login';
      $('#registerForm').hidden = tab !== 'register';
    });
  });

  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = $('#loginUsername').value.trim();
    const password = $('#loginPassword').value;
    socket.emit('auth:login', { username, password }, (res) => {
      if (!res.ok) return ($('#authError').textContent = res.error);
      localStorage.setItem('cc_token', res.token);
      app.token = res.token;
    });
  });

  $('#registerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = $('#regUsername').value.trim();
    const password = $('#regPassword').value;
    socket.emit('auth:register', { username, password }, (res) => {
      if (!res.ok) return ($('#authError').textContent = res.error);
      localStorage.setItem('cc_token', res.token);
      app.token = res.token;
    });
  });

  $('#logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('cc_token');
    location.reload();
  });

  socket.on('connect', () => {
    if (app.token) socket.emit('auth:resume', { token: app.token }, (res) => {
      if (!res.ok) { localStorage.removeItem('cc_token'); showScreen('authScreen'); }
    });
  });

  socket.on('auth:ready', ({ username, stats, ongoingRooms }) => {
    app.username = username;
    app.stats = stats;
    $('#topbarUser').hidden = false;
    $('#userChip').textContent = '@' + username;
    renderStats();
    showScreen('lobbyScreen');
    socket.emit('lobby:list', (res) => { renderRoomList(res.rooms); renderOnlineList(res.online); renderMyGames(res.rooms); });
  });

  // -------------------------------------------------------------------
  // 로비
  // -------------------------------------------------------------------
  function renderStats() {
    const s = app.stats || { w: 0, d: 0, l: 0 };
    $('#statsBox').innerHTML = `
      <div class="stat"><span class="n">${s.w}</span><span class="l">승</span></div>
      <div class="stat"><span class="n">${s.d}</span><span class="l">무</span></div>
      <div class="stat"><span class="n">${s.l}</span><span class="l">패</span></div>`;
  }

  function renderMyGames(rooms) {
    const panel = $('#myGamesPanel');
    const mine = (rooms || []).filter((r) => r.status !== 'finished' && r.players.some((p) => p.username === app.username));
    if (!mine.length) { panel.hidden = true; return; }
    panel.hidden = false;
    const el = $('#myGamesList');
    el.innerHTML = '';
    mine.forEach((r) => {
      const me = r.players.find((p) => p.username === app.username);
      const opponents = r.players.filter((p) => p.username !== app.username).map((p) => p.username).join(', ') || '상대 대기 중';
      const myTurn = r.status === 'ongoing' && r.turn === me.color;
      const card = document.createElement('div');
      card.className = 'room-card';
      card.innerHTML = `
        <div class="room-meta">
          <span class="room-tag">${MODE_LABEL[r.mode]} · ${r.timeControl ? r.timeControlKey : '무제한'} · ${r.status === 'ongoing' ? '진행중' : '대기중'}
            ${r.status === 'ongoing' ? `<span class="turn-hint ${myTurn ? 'mine' : 'theirs'}">${myTurn ? '내 차례' : '상대 차례'}</span>` : ''}
          </span>
          <span class="room-players">상대: ${opponents}${me.connected ? '' : ' · 내 연결 끊김'}</span>
        </div>`;
      const actions = document.createElement('div');
      actions.className = 'room-actions';
      const btn = document.createElement('button');
      btn.className = 'primary-btn';
      btn.textContent = '이어하기';
      btn.onclick = () => enterRoom(r.id);
      actions.appendChild(btn);
      card.appendChild(actions);
      el.appendChild(card);
    });
  }

  socket.on('lobby:update', ({ rooms, online }) => {
    renderRoomList(rooms);
    renderOnlineList(online);
    renderMyGames(rooms);
  });

  function renderRoomList(rooms) {
    const el = $('#roomList');
    if (!rooms.length) { el.innerHTML = '<div class="empty-hint">아직 열린 대국이 없습니다. 첫 대국을 만들어보세요!</div>'; return; }
    el.innerHTML = '';
    rooms.forEach((r) => {
      const card = document.createElement('div');
      card.className = 'room-card';
      const seats = r.mode === '1v1' ? 2 : 4;
      card.innerHTML = `
        <div class="room-meta">
          <span class="room-tag">${MODE_LABEL[r.mode]} · ${r.timeControl ? r.timeControlKey : '무제한'} · ${r.status === 'ongoing' ? '진행중' : r.status === 'waiting' ? '대기중' : '종료'}</span>
          <span class="room-players">${r.players.map((p) => p.username + (p.connected ? '' : '(끊김)')).join(', ') || '(비어있음)'} — ${r.players.length}/${seats}석 · 관전 ${r.spectatorCount}</span>
        </div>`;
      const actions = document.createElement('div');
      actions.className = 'room-actions';
      if (r.players.length < seats && r.status !== 'finished') {
        const joinBtn = document.createElement('button');
        joinBtn.className = 'primary-btn';
        joinBtn.textContent = '참가';
        joinBtn.onclick = () => enterRoom(r.id);
        actions.appendChild(joinBtn);
      }
      const specBtn = document.createElement('button');
      specBtn.className = 'ghost-btn';
      specBtn.textContent = '관전';
      specBtn.onclick = () => spectateRoom(r.id);
      actions.appendChild(specBtn);
      card.appendChild(actions);
      el.appendChild(card);
    });
  }

  function renderOnlineList(online) {
    const el = $('#onlineList');
    el.innerHTML = '';
    online.filter((u) => u !== app.username).forEach((u) => {
      const row = document.createElement('div');
      row.className = 'online-row';
      row.innerHTML = `<span><span class="online-dot"></span>${u}</span>`;
      const inviteBtn = document.createElement('button');
      inviteBtn.className = 'ghost-btn';
      inviteBtn.textContent = '초대';
      inviteBtn.onclick = () => openInviteModal(u);
      row.appendChild(inviteBtn);
      el.appendChild(row);
    });
    if (!el.children.length) el.innerHTML = '<div class="empty-hint">접속 중인 다른 플레이어가 없습니다.</div>';
  }

  $('#createRoomBtn').addEventListener('click', () => { $('#createRoomModal').hidden = false; });
  $('#cancelCreateBtn').addEventListener('click', () => { $('#createRoomModal').hidden = true; });
  $('#confirmCreateBtn').addEventListener('click', () => {
    const mode = $('#modeSelect').value;
    const timeControlKey = $('#timeSelect').value;
    socket.emit('lobby:createRoom', { mode, timeControlKey }, (res) => {
      $('#createRoomModal').hidden = true;
      if (res.ok) enterRoom(res.roomId);
    });
  });

  function enterRoom(roomId) {
    socket.emit('lobby:joinRoom', { roomId }, (res) => {
      if (!res.ok) return alert(res.error || '입장 실패');
      showScreen('gameScreen');
    });
  }
  function spectateRoom(roomId) {
    socket.emit('lobby:spectate', { roomId }, (res) => {
      if (!res.ok) return alert(res.error || '관전 실패');
      showScreen('gameScreen');
    });
  }

  // 우편함
  $('#inboxBtn').addEventListener('click', () => { $('#inboxModal').hidden = false; });
  $('#closeInboxBtn').addEventListener('click', () => { $('#inboxModal').hidden = true; });
  socket.on('inbox:update', (list) => {
    $('#inboxBadge').hidden = list.length === 0;
    $('#inboxBadge').textContent = list.length;
    const el = $('#inboxList');
    if (!list.length) { el.innerHTML = '<div class="empty-hint">새로운 초대가 없습니다.</div>'; return; }
    el.innerHTML = '';
    list.forEach((inv) => {
      const row = document.createElement('div');
      row.className = 'inbox-item';
      row.innerHTML = `<span>${inv.fromUsername}님이 ${MODE_LABEL[inv.mode]} 대국에 초대했습니다.</span>`;
      const acc = document.createElement('button');
      acc.className = 'primary-btn'; acc.textContent = '수락';
      acc.onclick = () => socket.emit('inbox:accept', { inviteId: inv.id }, (res) => {
        if (res.ok) { $('#inboxModal').hidden = true; showScreen('gameScreen'); }
      });
      const dec = document.createElement('button');
      dec.className = 'ghost-btn'; dec.textContent = '거절';
      dec.onclick = () => socket.emit('inbox:decline', { inviteId: inv.id });
      row.appendChild(acc); row.appendChild(dec);
      el.appendChild(row);
    });
  });

  let inviteTarget = null;
  function openInviteModal(username) {
    inviteTarget = username;
    $('#inviteTargetName').textContent = username;
    socket.emit('lobby:list', (res) => {
      const el = $('#inviteRoomChoices');
      const myRooms = res.rooms.filter((r) => r.players.some((p) => p.username === app.username));
      if (!myRooms.length) { el.innerHTML = '<div class="empty-hint">먼저 대국을 만들어야 초대할 수 있습니다.</div>'; }
      else {
        el.innerHTML = '';
        myRooms.forEach((r) => {
          const card = document.createElement('div');
          card.className = 'room-card';
          card.innerHTML = `<div class="room-meta"><span class="room-tag">${MODE_LABEL[r.mode]}</span></div>`;
          const btn = document.createElement('button');
          btn.className = 'primary-btn'; btn.textContent = '이 방으로 초대';
          btn.onclick = () => socket.emit('lobby:invite', { toUsername: inviteTarget, roomId: r.id }, () => { $('#inviteModal').hidden = true; });
          card.appendChild(btn);
          el.appendChild(card);
        });
      }
      $('#inviteModal').hidden = false;
    });
  }
  $('#closeInviteBtn').addEventListener('click', () => { $('#inviteModal').hidden = true; });

  $('#leaveGameBtn').addEventListener('click', () => {
    stopClockTicker();
    showScreen('lobbyScreen');
    socket.emit('lobby:list', (res) => { renderRoomList(res.rooms); renderOnlineList(res.online); renderMyGames(res.rooms); });
  });
  $('#backToLobbyBtn').addEventListener('click', () => {
    $('#gameOverModal').hidden = true;
    stopClockTicker();
    showScreen('lobbyScreen');
    socket.emit('lobby:list', (res) => { renderRoomList(res.rooms); renderOnlineList(res.online); renderMyGames(res.rooms); });
  });
  $('#reviewBtn').addEventListener('click', () => {
    $('#gameOverModal').hidden = true;
    startReview();
  });

  // -------------------------------------------------------------------
  // 게임 상태 수신 & 보드 렌더링
  // -------------------------------------------------------------------
  socket.on('game:state', (state) => {
    app.room = state;
    const me = state.players.find((p) => p.username === app.username);
    app.myColor = me ? me.color : null;
    app.isSpectator = !me;
    app.premove = app.premove && me ? app.premove : null;
    updateTeamChatVisibility();
    renderPlayers();
    renderBoard();
    renderMoveList();
    renderCaptures();
    startClockTicker();
    if (state.roomStatus === 'finished' || state.status !== 'ongoing') {
      showGameOver(state);
    }
  });

  function updateTeamChatVisibility() {
    $('#teamChatTabBtn').hidden = !(app.room && app.room.mode === '2v2' && app.myColor);
  }

  function localEngineState() {
    const s = app.room;
    return {
      mode: s.mode,
      board: new Map(s.board),
      valid: new Set(s.valid),
      width: s.width,
      height: s.height,
      eliminated: s.eliminated || {},
      enPassant: s.enPassant || null,
    };
  }

  function orientationFlip() {
    if (!app.room) return false;
    if (app.room.mode === '4p') return false;
    return app.myColor === 'black';
  }

  function renderBoard() {
    const state = app.reviewing ? app.reviewBoard : app.room;
    if (!state) return;
    const board = $('#board');
    const flip = orientationFlip();
    const w = state.width, h = state.height;
    const cell = Math.max(24, Math.min(58, Math.floor(600 / Math.max(w, h))));
    board.style.gridTemplateColumns = `repeat(${w}, ${cell}px)`;
    board.style.gridTemplateRows = `repeat(${h}, ${cell}px)`;
    board.innerHTML = '';
    const boardMap = new Map(state.board);
    const validSet = new Set(state.valid);
    const lastMove = state.history && state.history.length ? state.history[state.history.length - 1] : null;

    const rows = [];
    for (let r = h - 1; r >= 0; r--) rows.push(r);
    const displayRows = flip ? rows.slice().reverse() : rows;

    displayRows.forEach((r) => {
      const cols = [];
      for (let c = 0; c < w; c++) cols.push(c);
      const displayCols = flip ? cols.slice().reverse() : cols;
      displayCols.forEach((c) => {
        const k = c + ',' + r;
        const sq = document.createElement('div');
        sq.dataset.key = k;
        sq.style.width = cell + 'px';
        sq.style.height = cell + 'px';
        if (!validSet.has(k)) {
          sq.className = 'square void';
          board.appendChild(sq);
          return;
        }
        sq.className = 'square ' + ((c + r) % 2 === 0 ? 'dark' : 'light');
        if (app.selected === k) sq.classList.add('selected');
        if (app.premove && (app.premove.from === k || app.premove.to === k)) sq.classList.add('premove');
        if (lastMove && (lastMove.from === k || lastMove.to === k)) sq.classList.add('last-move');
        if (app.legalTargets.some((m) => m.to === k)) {
          sq.classList.add(app.legalTargets.find((m) => m.to === k).capture ? 'legal-capture' : 'legal-dot');
        }
        const piece = boardMap.get(k);
        if (piece) {
          if (piece.type === 'K' && !app.reviewing && state.status === 'checkmate' === false) {
            // no-op placeholder (check highlight handled below)
          }
          const glyph = document.createElement('span');
          glyph.className = `piece p-${piece.color}`;
          glyph.style.fontSize = Math.floor(cell * 0.72) + 'px';
          glyph.textContent = PIECE_GLYPH[piece.type];
          glyph.draggable = !app.reviewing;
          glyph.dataset.key = k;
          sq.appendChild(glyph);
        }
        if (c === (flip ? w - 1 : 0)) {
          const coord = document.createElement('span');
          coord.className = 'coord';
          coord.textContent = String(r + 1);
          sq.appendChild(coord);
        }
        board.appendChild(sq);
      });
    });

    if (!app.reviewing) attachBoardHandlers();
  }

  function attachBoardHandlers() {
    $all('.square', $('#board')).forEach((sq) => {
      sq.addEventListener('click', () => onSquareClick(sq.dataset.key));
      sq.addEventListener('dragover', (e) => e.preventDefault());
      sq.addEventListener('drop', (e) => { e.preventDefault(); onSquareClick(sq.dataset.key); });
    });
    $all('.piece', $('#board')).forEach((p) => {
      p.addEventListener('dragstart', (e) => {
        app.dragKey = p.dataset.key;
        onSquareClick(p.dataset.key, true);
        e.dataTransfer.setData('text/plain', p.dataset.key);
      });
    });
  }

  function myTurnNow() {
    return app.room && !app.isSpectator && app.room.status === 'ongoing' && app.room.turn === app.myColor;
  }

  function onSquareClick(k, isDragStart) {
    if (!app.room || app.reviewing || app.isSpectator) return;
    const state = localEngineState();
    const piece = state.board.get(k);

    // 이미 선택된 기물이 있고, 클릭한 칸이 합법 타겟이면 이동 실행
    if (app.selected && !isDragStart) {
      const target = app.legalTargets.find((m) => m.to === k);
      if (target) {
        submitMoveOrPremove(app.selected, k, target);
        clearSelection();
        return;
      }
    }
    clearSelection();
    if (!piece) return;
    const isMine = piece.color === app.myColor;
    if (!isMine) return;
    if (app.room.status !== 'ongoing') return;
    app.selected = k;
    const { col, row } = ChessEngine.parseKey(k);
    app.legalTargets = ChessEngine.getLegalMoves(state, col, row);
    renderBoard();
  }

  function clearSelection() { app.selected = null; app.legalTargets = []; }

  function submitMoveOrPremove(from, to, sampleMove) {
    const promoOptions = app.legalTargets.filter((m) => m.to === to && m.promotion);
    const finish = (promotion) => {
      if (myTurnNow()) {
        socket.emit('game:move', { roomId: app.room.roomId, from, to, promotion }, (res) => {
          if (!res.ok) flashNotice(res.error);
        });
      } else {
        app.premove = { from, to, promotion };
        socket.emit('game:premove', { roomId: app.room.roomId, from, to, promotion });
        renderBoard();
      }
    };
    if (promoOptions.length > 1) {
      showPromotionPicker(app.myColor, (choice) => finish(choice));
    } else {
      finish(sampleMove.promotion || undefined);
    }
  }

  function showPromotionPicker(color, cb) {
    const modal = $('#promotionModal');
    const box = $('#promoChoices');
    box.innerHTML = '';
    ['Q', 'R', 'B', 'N'].forEach((t) => {
      const btn = document.createElement('button');
      btn.className = `piece p-${color}`;
      btn.textContent = PIECE_GLYPH[t];
      btn.onclick = () => { modal.hidden = true; cb(t); };
      box.appendChild(btn);
    });
    modal.hidden = false;
  }

  function flashNotice(text) {
    const n = $('#notice');
    n.hidden = false;
    n.textContent = text;
    clearTimeout(flashNotice._t);
    flashNotice._t = setTimeout(() => { n.hidden = true; }, 2600);
  }

  // -------------------------------------------------------------------
  // 플레이어 스트립 / 시계
  // -------------------------------------------------------------------
  function renderPlayers() {
    const s = app.room;
    if (!s) return;
    const top = $('#topPlayerStrip'), bottom = $('#bottomPlayerStrip');
    top.innerHTML = ''; bottom.innerHTML = '';
    let order = s.players.slice();
    if (s.mode !== '4p') {
      // 내 색을 하단에 배치
      order.sort((a, b) => (a.color === app.myColor ? 1 : 0) - (b.color === app.myColor ? 1 : 0));
    }
    order.forEach((p, idx) => {
      const card = document.createElement('div');
      card.className = 'player-card' + (s.turn === p.color && s.status === 'ongoing' ? ' active-turn' : '');
      const dotColor = { white: '#efe6d8', black: '#201a12', p1: '#3f8f8a', p2: '#b3432b', p3: '#6a4fb3', p4: '#c9973e' }[p.color];
      card.innerHTML = `<span class="player-color-dot" style="background:${dotColor}"></span>
        <span class="player-name">${p.username}${p.connected ? '' : ' (연결 끊김)'}</span>
        <span class="clock" data-color="${p.color}">${formatClock(s.clocks ? s.clocks[p.color] : null)}</span>`;
      (s.mode !== '4p' && idx === order.length - 1 ? bottom : (s.mode !== '4p' ? top : (idx % 2 === 0 ? top : bottom))).appendChild(card);
    });
  }

  function formatClock(ms) {
    if (ms === null || ms === undefined) return '∞';
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60), sec = total % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function startClockTicker() {
    stopClockTicker();
    if (!app.room || !app.room.clocks) return;
    let clocks = Object.assign({}, app.room.clocks);
    const turn = app.room.turn;
    const started = Date.now();
    app.clockInterval = setInterval(() => {
      if (!app.room || app.room.status !== 'ongoing') return stopClockTicker();
      const elapsed = Date.now() - started;
      $all('.clock', document).forEach((el) => {
        const color = el.dataset.color;
        let ms = clocks[color];
        if (color === turn) ms = Math.max(0, ms - elapsed);
        el.textContent = formatClock(ms);
        el.classList.toggle('low', ms !== null && ms !== undefined && ms < 15000);
      });
    }, 250);
  }
  function stopClockTicker() { if (app.clockInterval) clearInterval(app.clockInterval); app.clockInterval = null; }

  // -------------------------------------------------------------------
  // 기보 / 잡힌 기물
  // -------------------------------------------------------------------
  function renderMoveList() {
    const s = app.room;
    const el = $('#moveList');
    el.innerHTML = '';
    (s.history || []).forEach((h, i) => {
      const li = document.createElement('li');
      li.textContent = `${h.san}${h.checkmate ? '#' : h.check ? '+' : ''}`;
      li.title = COLOR_LABEL[h.color] || h.color;
      el.appendChild(li);
    });
  }

  function renderCaptures() {
    const s = app.room;
    const el = $('#captureBar');
    el.innerHTML = '';
    Object.entries(s.captured || {}).forEach(([color, list]) => {
      if (!list.length) return;
      const span = document.createElement('span');
      span.style.marginRight = '10px';
      span.innerHTML = `<small style="font-family:var(--font-mono);opacity:.6">${COLOR_LABEL[color]}쪽 상실:</small> ` +
        list.map((t) => `<span class="piece p-${color === 'white' ? 'black' : color === 'black' ? 'white' : color}" style="font-size:1rem">${PIECE_GLYPH[t]}</span>`).join('');
      el.appendChild(span);
    });
  }

  // -------------------------------------------------------------------
  // 게임 컨트롤
  // -------------------------------------------------------------------
  $('#resignBtn').addEventListener('click', () => {
    if (!app.room || app.isSpectator) return;
    if (confirm('정말 기권하시겠습니까?')) socket.emit('game:resign', { roomId: app.room.roomId });
  });
  $('#offerDrawBtn').addEventListener('click', () => {
    if (!app.room || app.isSpectator) return;
    socket.emit('game:offerDraw', { roomId: app.room.roomId });
    flashNotice('무승부를 제안했습니다.');
  });
  $('#takebackBtn').addEventListener('click', () => {
    if (!app.room || app.isSpectator) return;
    socket.emit('game:requestTakeback', { roomId: app.room.roomId });
    flashNotice('무르기를 요청했습니다.');
  });

  socket.on('game:drawOffered', ({ from }) => {
    if (from === app.username) return;
    if (confirm(`${from}님이 무승부를 제안했습니다. 수락하시겠습니까?`)) {
      socket.emit('game:respondDraw', { roomId: app.room.roomId, accept: true });
    } else {
      socket.emit('game:respondDraw', { roomId: app.room.roomId, accept: false });
    }
  });
  socket.on('game:drawDeclined', () => flashNotice('무승부 제안이 거절되었습니다.'));
  socket.on('game:takebackRequested', ({ from }) => {
    if (from === app.username) return;
    const accept = confirm(`${from}님이 무르기를 요청했습니다. 수락하시겠습니까?`);
    socket.emit('game:respondTakeback', { roomId: app.room.roomId, accept });
  });

  socket.on('game:over', ({ status, winner, reason }) => {
    // game:state 이벤트가 곧이어 최신 상태를 보내므로 여기서는 알림만
  });

  function showGameOver(state) {
    const modal = $('#gameOverModal');
    if (modal.dataset.shownFor === state.roomId + '-' + state.status) return;
    modal.dataset.shownFor = state.roomId + '-' + state.status;
    let title = '대국 종료';
    if (state.winner) {
      title = state.mode === '4p' ? `${COLOR_LABEL[state.winner]} 승리!` : `${COLOR_LABEL[state.winner]} 팀 승리!`;
    } else if (state.status === 'draw' || state.status === 'stalemate') {
      title = '무승부';
    }
    $('#gameOverTitle').textContent = title;
    $('#gameOverReason').textContent = state.resultReason || '';
    modal.hidden = false;
  }

  // -------------------------------------------------------------------
  // 채팅
  // -------------------------------------------------------------------
  $all('.tab-btn[data-sidetab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $all('.tab-btn[data-sidetab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      app.sideTab = btn.dataset.sidetab;
      $('#movesPane').hidden = app.sideTab !== 'moves';
      $('#chatPane').hidden = app.sideTab !== 'chat';
      $('#teamChatPane').hidden = app.sideTab !== 'teamchat';
    });
  });

  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    if (!input.value.trim() || !app.room) return;
    socket.emit('chat:send', { roomId: app.room.roomId, message: input.value.trim(), scope: 'all' });
    input.value = '';
  });
  $('#teamChatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#teamChatInput');
    if (!input.value.trim() || !app.room) return;
    socket.emit('chat:send', { roomId: app.room.roomId, message: input.value.trim(), scope: 'team' });
    input.value = '';
  });
  socket.on('chat:all', (entry) => appendChat('#chatLog', entry));
  socket.on('chat:team', (entry) => appendChat('#teamChatLog', entry));
  function appendChat(sel, entry) {
    const el = $(sel);
    const row = document.createElement('div');
    row.className = 'chat-msg';
    row.innerHTML = `<span class="who">${entry.username}</span>${escapeHtml(entry.message)}`;
    el.appendChild(row);
    el.scrollTop = el.scrollHeight;
  }
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // -------------------------------------------------------------------
  // 복기 모드
  // -------------------------------------------------------------------
  function startReview() {
    app.reviewing = true;
    $('#replayControls').hidden = false;
    $('.game-controls').style && ($('#resignBtn').disabled = true, $('#offerDrawBtn').disabled = true, $('#takebackBtn').disabled = true);
    app.reviewIndex = app.room.history.length;
    rebuildReviewBoard();
  }

  function rebuildReviewBoard() {
    const fresh = ChessEngine.createGame(app.room.mode);
    const hist = app.room.history.slice(0, app.reviewIndex);
    hist.forEach((h) => ChessEngine.makeMove(fresh, h.from, h.to, h.promotion || undefined));
    app.reviewBoard = {
      mode: fresh.mode, board: [...fresh.board.entries()], valid: [...fresh.valid],
      width: fresh.width, height: fresh.height, history: hist, status: 'review',
    };
    $('#replayIndex').textContent = `${app.reviewIndex} / ${app.room.history.length}`;
    renderBoard();
  }
  $('#replayFirst').addEventListener('click', () => { app.reviewIndex = 0; rebuildReviewBoard(); });
  $('#replayPrev').addEventListener('click', () => { app.reviewIndex = Math.max(0, app.reviewIndex - 1); rebuildReviewBoard(); });
  $('#replayNext').addEventListener('click', () => { app.reviewIndex = Math.min(app.room.history.length, app.reviewIndex + 1); rebuildReviewBoard(); });
  $('#replayLast').addEventListener('click', () => { app.reviewIndex = app.room.history.length; rebuildReviewBoard(); });

})();

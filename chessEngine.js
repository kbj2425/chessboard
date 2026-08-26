/**
 * chessEngine.js
 * 서버(Node.js, 판정 권위)와 클라이언트(미리보기 하이라이트) 양쪽에서 공유되는
 * 체스 규칙 엔진. DB를 쓰지 않고, 순수 JS 객체로 게임 상태를 표현한다.
 *
 * 지원 모드
 *  - "1v1" : 표준 8x8 FIDE 규칙
 *  - "2v2" : 16x8 팀 체스 (각 팀 2세트, 킹 2개, 첫 킹은 희생 가능)
 *  - "4p"  : 14x14 바운딩 박스의 십자형 4인 체스 (각자 킹 1개, 프리포올)
 *
 * 이 파일은 Node(module.exports)와 브라우저(window.ChessEngine) 양쪽에서 동작한다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ChessEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FILES = 'abcdefghijklmnop'.split(''); // 최대 16파일까지 지원 (2v2)

  function key(col, row) { return col + ',' + row; }
  function parseKey(k) { const [c, r] = k.split(',').map(Number); return { col: c, row: r }; }

  // ---------------------------------------------------------------------
  // 보드 셋업
  // ---------------------------------------------------------------------

  function buildStandardBoard() {
    const board = new Map();
    const valid = new Set();
    for (let c = 0; c < 8; c++) for (let r = 0; r < 8; r++) valid.add(key(c, r));
    const backRank = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
    for (let c = 0; c < 8; c++) {
      board.set(key(c, 0), piece(backRank[c], 'white', 'p1'));
      board.set(key(c, 1), piece('P', 'white', 'p1'));
      board.set(key(c, 6), piece('P', 'black', 'p2'));
      board.set(key(c, 7), piece(backRank[c], 'black', 'p2'));
    }
    return { board, valid, width: 8, height: 8 };
  }

  // 16 x 8: 각 팀이 두 세트를 나란히 배치. 열 0-7 = 해당 팀 P1 세트, 열 8-15 = P2 세트.
  function buildTeamBoard() {
    const board = new Map();
    const valid = new Set();
    for (let c = 0; c < 16; c++) for (let r = 0; r < 8; r++) valid.add(key(c, r));
    const backRank = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
    const place = (colorOffset, row, pawnRow, color, owner) => {
      for (let i = 0; i < 8; i++) {
        const c = colorOffset + i;
        board.set(key(c, row), piece(backRank[i], color, owner));
        board.set(key(c, pawnRow), piece('P', color, owner));
      }
    };
    place(0, 0, 1, 'white', 'p1');
    place(8, 0, 1, 'white', 'p3');
    place(0, 7, 6, 'black', 'p2');
    place(8, 7, 6, 'black', 'p4');
    return { board, valid, width: 16, height: 8 };
  }

  // 14x14 바운딩박스의 십자형 (중앙 8x8 + 상하좌우 3x8/8x3 날개). 4인용.
  function buildCrossBoard() {
    const valid = new Set();
    const N = 14; // bounding box
    const wingStart = 3, wingEnd = 11; // 중앙 8칸 (3..10)
    for (let c = 0; c < N; c++) {
      for (let r = 0; r < N; r++) {
        const inCenterCols = c >= wingStart && c < wingEnd;
        const inCenterRows = r >= wingStart && r < wingEnd;
        if (inCenterCols || inCenterRows) valid.add(key(c, r));
      }
    }
    const board = new Map();
    const backRank = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
    // p1: 아래쪽(화이트 방향, row 0-1), 중앙 열 3..10
    for (let i = 0; i < 8; i++) {
      board.set(key(wingStart + i, 0), piece(backRank[i], 'p1', 'p1'));
      board.set(key(wingStart + i, 1), piece('P', 'p1', 'p1'));
    }
    // p2: 위쪽 (row 12-13)
    for (let i = 0; i < 8; i++) {
      board.set(key(wingStart + i, N - 1), piece(backRank[i], 'p2', 'p2'));
      board.set(key(wingStart + i, N - 2), piece('P', 'p2', 'p2'));
    }
    // p3: 왼쪽 (col 0-1), 폰은 오른쪽(안쪽)을 향해 전진
    for (let i = 0; i < 8; i++) {
      board.set(key(0, wingStart + i), piece(backRank[i], 'p3', 'p3'));
      board.set(key(1, wingStart + i), piece('P', 'p3', 'p3'));
    }
    // p4: 오른쪽 (col 12-13), 폰은 왼쪽(안쪽)을 향해 전진
    for (let i = 0; i < 8; i++) {
      board.set(key(N - 1, wingStart + i), piece(backRank[i], 'p4', 'p4'));
      board.set(key(N - 2, wingStart + i), piece('P', 'p4', 'p4'));
    }
    return { board, valid, width: N, height: N };
  }

  function piece(type, color, owner) {
    return { type, color, owner, hasMoved: false };
  }

  // 각 색상(플레이어)의 폰 전진 방향 (dCol, dRow)
  const PAWN_DIR = {
    white: { dc: 0, dr: 1 },
    black: { dc: 0, dr: -1 },
    p1: { dc: 0, dr: 1 },
    p2: { dc: 0, dr: -1 },
    p3: { dc: 1, dr: 0 },
    p4: { dc: -1, dr: 0 },
  };

  // 팀 매핑: 2v2에서는 white/black 색상 자체가 팀. 4p는 자유대전(팀 없음).
  function teamOf(mode, color) {
    if (mode === '2v2') return color; // 'white' | 'black'
    if (mode === '1v1') return color;
    return color; // 4p: 개인전, 색상=본인
  }

  function enemyColors(mode, color) {
    if (mode === '1v1') return color === 'white' ? ['black'] : ['white'];
    if (mode === '2v2') return color === 'white' ? ['black'] : ['white'];
    return ['p1', 'p2', 'p3', 'p4'].filter((c) => c !== color);
  }

  // ---------------------------------------------------------------------
  // 게임 상태 생성
  // ---------------------------------------------------------------------

  function createGame(mode, opts) {
    opts = opts || {};
    let setup;
    if (mode === '1v1') setup = buildStandardBoard();
    else if (mode === '2v2') setup = buildTeamBoard();
    else if (mode === '4p') setup = buildCrossBoard();
    else throw new Error('unknown mode ' + mode);

    const colors = mode === '4p' ? ['p1', 'p2', 'p3', 'p4'] : ['white', 'black'];

    const state = {
      mode,
      board: setup.board,
      valid: setup.valid,
      width: setup.width,
      height: setup.height,
      turnOrder: colors,
      turnIndex: 0,
      get turn() { return this.turnOrder[this.turnIndex]; },
      enPassant: null, // {key, capturableKey}
      halfmoveClock: 0,
      fullmoveNumber: 1,
      history: [], // {san, from, to, color, ...}
      captured: {}, // color -> [pieceType,...] captured FROM that color
      eliminated: {}, // 4p: color -> true
      status: 'ongoing', // ongoing | checkmate | stalemate | draw | resigned | timeout | teamwin
      winner: null,
      resultReason: null,
      positionCounts: new Map(),
    };
    colors.forEach((c) => { state.captured[c] = []; });
    recordPosition(state);
    return state;
  }

  function cloneLite(state) {
    // 얕은 구조 복제 (보드만 깊은 복제) - 무브 시뮬레이션용
    const clone = Object.assign({}, state);
    clone.board = new Map(state.board);
    clone.captured = JSON.parse(JSON.stringify(state.captured));
    clone.eliminated = Object.assign({}, state.eliminated);
    clone.enPassant = state.enPassant ? Object.assign({}, state.enPassant) : null;
    return clone;
  }

  // ---------------------------------------------------------------------
  // 이동 생성 (Pseudo-legal)
  // ---------------------------------------------------------------------

  const SLIDING = {
    B: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
    R: [[1, 0], [-1, 0], [0, 1], [0, -1]],
    Q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
  };
  const KNIGHT_OFFSETS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING_OFFSETS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

  function inBounds(state, c, r) {
    return state.valid.has(key(c, r));
  }

  function pieceAt(state, c, r) {
    return state.board.get(key(c, r));
  }

  // 특정 칸을 공격 중인 기물이 있는지 (체크 판정용). pseudo-move 기반, 자신의 킹 안전은 고려 안 함.
  function isSquareAttacked(state, col, row, byColors) {
    for (const [k, p] of state.board) {
      if (!byColors.includes(p.color)) continue;
      const { col: pc, row: pr } = parseKey(k);
      if (attacksSquare(state, p, pc, pr, col, row)) return true;
    }
    return false;
  }

  function attacksSquare(state, p, fc, fr, tc, tr) {
    const dc = tc - fc, dr = tr - fr;
    if (p.type === 'N') {
      return KNIGHT_OFFSETS.some(([x, y]) => x === dc && y === dr);
    }
    if (p.type === 'K') {
      return Math.abs(dc) <= 1 && Math.abs(dr) <= 1 && (dc !== 0 || dr !== 0);
    }
    if (p.type === 'P') {
      const dir = PAWN_DIR[p.color];
      // 대각선 공격 두 방향 (전진축 기준 수직으로 +-1)
      if (dir.dc === 0) {
        return dr === dir.dr && Math.abs(dc) === 1;
      } else {
        return dc === dir.dc && Math.abs(dr) === 1;
      }
    }
    const dirs = SLIDING[p.type];
    if (!dirs) return false;
    for (const [ddc, ddr] of dirs) {
      if (ddc === 0 && ddr === 0) continue;
      // 방향이 같은 직선/대각선 위에 있는지 확인
      if (ddc !== 0 && ddr !== 0) {
        if (Math.abs(dc) !== Math.abs(dr) || dc === 0) continue;
        if (Math.sign(dc) !== ddc || Math.sign(dr) !== ddr) continue;
      } else if (ddc !== 0) {
        if (dr !== 0 || Math.sign(dc) !== ddc) continue;
      } else {
        if (dc !== 0 || Math.sign(dr) !== ddr) continue;
      }
      // 경로에 막힘이 없는지 확인
      const steps = Math.max(Math.abs(dc), Math.abs(dr));
      let blocked = false;
      for (let s = 1; s < steps; s++) {
        const cc = fc + ddc * s, cr = fr + ddr * s;
        if (pieceAt(state, cc, cr)) { blocked = true; break; }
      }
      if (!blocked) return true;
    }
    return false;
  }

  function findKings(state, color) {
    const out = [];
    for (const [k, p] of state.board) {
      if (p.type === 'K' && p.color === color) out.push(parseKey(k));
    }
    return out;
  }

  function generatePseudoMoves(state, fromCol, fromRow) {
    const p = pieceAt(state, fromCol, fromRow);
    if (!p) return [];
    const moves = [];
    const push = (c, r, flags) => {
      if (!inBounds(state, c, r)) return;
      const target = pieceAt(state, c, r);
      if (target && target.color === p.color) return;
      moves.push(Object.assign({ from: key(fromCol, fromRow), to: key(c, r), capture: !!target }, flags || {}));
    };

    if (p.type === 'N') {
      KNIGHT_OFFSETS.forEach(([dc, dr]) => push(fromCol + dc, fromRow + dr));
    } else if (p.type === 'K') {
      KING_OFFSETS.forEach(([dc, dr]) => push(fromCol + dc, fromRow + dr));
      // 캐슬링
      if (!p.hasMoved) {
        [-1, 1].forEach((dir) => {
          // 같은 행에서 dir 방향으로 처음 만나는 기물이 안 움직인 자기 편 룩인지 확인
          let c = fromCol + dir;
          while (inBounds(state, c, fromRow) && !pieceAt(state, c, fromRow)) c += dir;
          const rook = pieceAt(state, c, fromRow);
          if (rook && rook.type === 'R' && rook.color === p.color && !rook.hasMoved) {
            const kingTo = fromCol + dir * 2;
            const rookTo = fromCol + dir;
            // 왕이 지나가는 경로가 비어있는지 (킹 위치 포함 2칸)
            let clear = true;
            for (let cc = fromCol; cc !== kingTo + dir; cc += dir) {
              if (cc === fromCol) continue;
              if (pieceAt(state, cc, fromRow)) { clear = false; break; }
            }
            if (clear && inBounds(state, kingTo, fromRow)) {
              moves.push({ from: key(fromCol, fromRow), to: key(kingTo, fromRow), castle: { rookFrom: key(c, fromRow), rookTo: key(rookTo, fromRow) } });
            }
          }
        });
      }
    } else if (p.type === 'P') {
      const dir = PAWN_DIR[p.color];
      const oneC = fromCol + dir.dc, oneR = fromRow + dir.dr;
      if (inBounds(state, oneC, oneR) && !pieceAt(state, oneC, oneR)) {
        addPawnAdvance(state, p, fromCol, fromRow, oneC, oneR, moves);
        // 첫 이동 2칸
        if (!p.hasMoved) {
          const twoC = fromCol + dir.dc * 2, twoR = fromRow + dir.dr * 2;
          if (inBounds(state, twoC, twoR) && !pieceAt(state, twoC, twoR)) {
            moves.push({ from: key(fromCol, fromRow), to: key(twoC, twoR), doubleStep: true, passedKey: key(oneC, oneR) });
          }
        }
      }
      // 대각 공격 (전진 방향에 수직인 +-1)
      const perp = dir.dc === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
      perp.forEach(([pc, pr]) => {
        const c = fromCol + dir.dc + pc, r = fromRow + dir.dr + pr;
        if (!inBounds(state, c, r)) return;
        const target = pieceAt(state, c, r);
        if (target && target.color !== p.color) {
          addPawnAdvance(state, p, fromCol, fromRow, c, r, moves, true);
        } else if (!target && state.enPassant && state.enPassant.key === key(c, r)) {
          moves.push({ from: key(fromCol, fromRow), to: key(c, r), enPassant: true, capturedKey: state.enPassant.capturableKey });
        }
      });
    } else {
      const dirs = SLIDING[p.type];
      dirs.forEach(([dc, dr]) => {
        let c = fromCol + dc, r = fromRow + dr;
        while (inBounds(state, c, r)) {
          const target = pieceAt(state, c, r);
          if (target) {
            if (target.color !== p.color) push(c, r);
            break;
          }
          push(c, r);
          c += dc; r += dr;
        }
      });
    }
    return moves;
  }

  // 4인 모드 프로모션 구역: 중앙 8x8(열 3..10, 행 3..10)의 정중앙 4칸 (d4,d5,e4,e5 상당)
  function isCrossPromotionSquare(c, r) {
    return (c === 6 || c === 7) && (r === 6 || r === 7);
  }

  function addPawnAdvance(state, p, fromCol, fromRow, c, r, moves, isCapture) {
    let promote = false;
    if (state.mode === '4p') {
      promote = isCrossPromotionSquare(c, r);
    } else {
      const lastRow = PAWN_DIR[p.color].dr > 0 ? state.height - 1 : 0;
      promote = r === lastRow;
    }
    if (promote) {
      ['Q', 'R', 'B', 'N'].forEach((pt) => {
        moves.push({ from: key(fromCol, fromRow), to: key(c, r), capture: !!isCapture, promotion: pt });
      });
    } else {
      moves.push({ from: key(fromCol, fromRow), to: key(c, r), capture: !!isCapture });
    }
  }

  // ---------------------------------------------------------------------
  // 합법 이동 (자기 킹 안전 필터링, 모드별 킹 규칙 적용)
  // ---------------------------------------------------------------------

  function kingCountForTeam(state, team) {
    // 2v2: team === 'white'|'black' 색상 자체가 팀
    let n = 0;
    for (const p of state.board.values()) {
      if (p.type === 'K' && teamOf(state.mode, p.color) === team) n++;
    }
    return n;
  }

  function mustAvoidSelfCheck(state, color) {
    if (state.mode === '4p' || state.mode === '1v1') return true;
    // 2v2: 팀에 킹이 2개 남아있으면 자기 체크 무시(희생 가능), 1개 남으면 표준 규칙
    const team = teamOf(state.mode, color);
    return kingCountForTeam(state, team) <= 1;
  }

  function getLegalMoves(state, fromCol, fromRow) {
    const p = pieceAt(state, fromCol, fromRow);
    if (!p) return [];
    if (state.eliminated[p.color]) return [];
    const pseudo = generatePseudoMoves(state, fromCol, fromRow);
    const enforceCheck = mustAvoidSelfCheck(state, p.color);
    return pseudo.filter((m) => {
      if (m.castle) {
        // 캐슬링: 킹이 체크 상태이거나, 지나가는 칸/도착 칸이 공격받으면 불가 (항상 적용)
        const enemies = enemyColors(state.mode, p.color);
        if (isSquareAttacked(state, fromCol, fromRow, enemies)) return false;
        const { col: toCol } = parseKey(m.to);
        const dir = toCol > fromCol ? 1 : -1;
        for (let c = fromCol; c !== toCol + dir; c += dir) {
          if (isSquareAttacked(state, c, fromRow, enemies)) return false;
        }
      }
      if (!enforceCheck) return true;
      const sim = cloneLite(state);
      applyMoveInternal(sim, m, { simulate: true });
      const kings = findKings(sim, p.color);
      const enemies = enemyColors(state.mode, p.color);
      return !kings.some((kp) => isSquareAttacked(sim, kp.col, kp.row, enemies));
    });
  }

  function getAllLegalMoves(state, color) {
    const out = [];
    for (const [k, p] of state.board) {
      if (p.color !== color) continue;
      const { col, row } = parseKey(k);
      out.push(...getLegalMoves(state, col, row));
    }
    return out;
  }

  function isInCheck(state, color) {
    const kings = findKings(state, color);
    if (!kings.length) return false;
    const enemies = enemyColors(state.mode, color);
    return kings.some((kp) => isSquareAttacked(state, kp.col, kp.row, enemies));
  }

  // ---------------------------------------------------------------------
  // 이동 적용
  // ---------------------------------------------------------------------

  function applyMoveInternal(state, move, opts) {
    opts = opts || {};
    const from = parseKey(move.from);
    const to = parseKey(move.to);
    const p = state.board.get(move.from);
    let captured = null;

    if (move.enPassant) {
      captured = state.board.get(move.capturedKey);
      state.board.delete(move.capturedKey);
    } else if (move.capture) {
      captured = state.board.get(move.to);
    }

    state.board.delete(move.from);
    const moved = Object.assign({}, p, { hasMoved: true });
    if (move.promotion) moved.type = move.promotion;
    state.board.set(move.to, moved);

    if (move.castle) {
      const rook = state.board.get(move.castle.rookFrom);
      state.board.delete(move.castle.rookFrom);
      state.board.set(move.castle.rookTo, Object.assign({}, rook, { hasMoved: true }));
    }

    // 앙파상 타겟 갱신
    state.enPassant = move.doubleStep ? { key: move.passedKey, capturableKey: move.to } : null;

    // 50수 규칙 카운터
    if (p.type === 'P' || move.capture || move.enPassant) state.halfmoveClock = 0;
    else state.halfmoveClock += 1;

    if (captured) {
      if (!opts.simulate) {
        if (!state.captured[captured.color]) state.captured[captured.color] = [];
        state.captured[captured.color].push(captured.type);
      }
      if (captured.type === 'K' && !opts.simulate) {
        handleKingCapture(state, captured.color);
      }
    }
    return captured;
  }

  function handleKingCapture(state, color) {
    if (state.mode === '2v2') {
      const team = teamOf(state.mode, color);
      if (kingCountForTeam(state, team) === 0) {
        const otherTeam = team === 'white' ? 'black' : 'white';
        state.status = 'teamwin';
        state.winner = otherTeam;
        state.resultReason = `${team === 'white' ? '화이트' : '블랙'} 팀의 킹이 모두 잡혔습니다.`;
      }
    } else if (state.mode === '4p') {
      state.eliminated[color] = true;
      const remaining = ['p1', 'p2', 'p3', 'p4'].filter((c) => !state.eliminated[c]);
      if (remaining.length === 1) {
        state.status = 'checkmate';
        state.winner = remaining[0];
        state.resultReason = `${remaining[0]}만 남아 승리했습니다.`;
      }
    }
  }

  function toSAN(state, move, p) {
    const files = FILES;
    const fromP = parseKey(move.from);
    const toP = parseKey(move.to);
    if (move.castle) {
      return toP.col > fromP.col ? 'O-O' : 'O-O-O';
    }
    const pieceLetter = p.type === 'P' ? '' : p.type;
    const capture = (move.capture || move.enPassant) ? 'x' : '';
    const fromFile = p.type === 'P' && capture ? files[fromP.col] : '';
    const dest = files[toP.col] + (toP.row + 1);
    const promo = move.promotion ? '=' + move.promotion : '';
    return `${pieceLetter}${fromFile}${capture}${dest}${promo}`;
  }

  function recordPosition(state) {
    if (state.mode !== '1v1') return; // 삼수동형 반복은 1v1에서만 추적
    const parts = [];
    for (const [k, p] of [...state.board.entries()].sort()) parts.push(k + p.type + p.color[0]);
    const sig = parts.join('|') + '_' + state.turn;
    const n = (state.positionCounts.get(sig) || 0) + 1;
    state.positionCounts.set(sig, n);
    return n;
  }

  // move: {from, to, promotion?} - 클라이언트가 요청한 좌표 기반 수
  function makeMove(state, fromKey, toKey, promotion) {
    if (state.status !== 'ongoing') return { ok: false, reason: 'game_over' };
    const { col, row } = parseKey(fromKey);
    const p = pieceAt(state, col, row);
    if (!p) return { ok: false, reason: 'empty_square' };
    if (p.color !== state.turn) return { ok: false, reason: 'not_your_turn' };
    if (state.eliminated[p.color]) return { ok: false, reason: 'eliminated' };
    const legal = getLegalMoves(state, col, row).filter((m) => m.to === toKey && (!m.promotion || m.promotion === promotion));
    let move = legal[0];
    if (!move) {
      // 프로모션 지정 없이 요청된 경우 기본 퀸 승급으로 시도
      move = getLegalMoves(state, col, row).find((m) => m.to === toKey && m.promotion === 'Q');
    }
    if (!move) return { ok: false, reason: 'illegal_move' };

    const san = toSAN(state, move, p);
    const capturedPiece = applyMoveInternal(state, move, {});
    const color = p.color;

    advanceTurn(state);

    const rep = recordPosition(state);
    const nextColor = state.turn;
    let check = false, checkmate = false, stalemate = false;
    if (state.status === 'ongoing' && !state.eliminated[nextColor]) {
      check = isInCheck(state, nextColor);
      const legalCount = getAllLegalMoves(state, nextColor).length;
      if (legalCount === 0) {
        if (check) {
          checkmate = true;
          state.status = 'checkmate';
          state.winner = state.mode === '4p' ? color : teamOf(state.mode, color);
          state.resultReason = '체크메이트';
          if (state.mode === '4p') { state.eliminated[nextColor] = true; }
        } else {
          stalemate = true;
          state.status = 'stalemate';
          state.resultReason = '스테일메이트 (무승부)';
        }
      }
    }
    if (state.status === 'ongoing') {
      if (state.halfmoveClock >= 100) {
        state.status = 'draw'; state.resultReason = '50수 규칙';
      } else if (rep >= 3) {
        state.status = 'draw'; state.resultReason = '3수 동형 반복';
      }
    }

    state.history.push({ san, from: fromKey, to: toKey, color, capture: !!capturedPiece, check, checkmate, promotion: move.promotion || null });
    return { ok: true, move, san, check, checkmate, stalemate, capturedPiece, status: state.status, winner: state.winner };
  }

  function advanceTurn(state) {
    if (state.mode === '4p') {
      let next = state.turnIndex;
      for (let i = 0; i < state.turnOrder.length; i++) {
        next = (next + 1) % state.turnOrder.length;
        if (!state.eliminated[state.turnOrder[next]]) break;
      }
      state.turnIndex = next;
    } else {
      state.turnIndex = (state.turnIndex + 1) % state.turnOrder.length;
      if (state.turnIndex === 0) state.fullmoveNumber += 1;
    }
  }

  function pgn(state, meta) {
    meta = meta || {};
    let out = '';
    Object.entries(meta).forEach(([k, v]) => { out += `[${k} "${v}"]\n`; });
    out += '\n';
    let moveNo = 1;
    for (let i = 0; i < state.history.length; i += (state.mode === '1v1' ? 2 : state.turnOrder.length)) {
      out += `${moveNo}. `;
      for (let j = 0; j < (state.mode === '1v1' ? 2 : state.turnOrder.length); j++) {
        const h = state.history[i + j];
        if (!h) break;
        out += h.san + (h.checkmate ? '#' : h.check ? '+' : '') + ' ';
      }
      moveNo++;
    }
    return out.trim();
  }

  return {
    createGame,
    getLegalMoves,
    getAllLegalMoves,
    makeMove,
    isInCheck,
    parseKey,
    key,
    FILES,
    pgn,
    teamOf,
  };
});

/* =========================================================
   역사탐험대 : 선사시대 생존기 — 멀티플레이 서버
   ---------------------------------------------------------
   · 순수 Node + ws 만 사용합니다 (DB 필요 없음)
   · Render / Fly.io / Railway / 교실 노트북 어디서나 동작합니다
   · 같은 서버가 게임 파일(index.html)도 함께 나눠 줍니다
     → 한 곳에만 배포하면 끝
   ========================================================= */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const db   = require('./db');
const auth = require('./auth');

const PORT = process.env.PORT || 8080;

/* 게임 파일 위치 : server/ 의 부모 폴더에 있는 index.html */
const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',   '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav'
};

/* ---------------------------------------------------------
   정적 파일 서버
   --------------------------------------------------------- */
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const CORS = { 'access-control-allow-origin':'*', 'cache-control':'no-store' };
  if (url === '/health') {
    res.writeHead(200, Object.assign({'content-type':'text/plain'}, CORS));
    return res.end('ok');
  }
  if (url === '/rooms') {                      // 시작 화면의 "열려 있는 방" 목록
    res.writeHead(200, Object.assign({'content-type':'application/json; charset=utf-8'}, CORS));
    return res.end(JSON.stringify([...rooms.values()].map(r => {
      const host = r.players.get(r.hostId);
      return {
        code: r.code,
        host: host ? host.name : '탐험가',
        players: r.players.size,
        era: r.era,
        full: r.players.size >= MAX_PLAYERS
      };
    })));
  }

  /* ---------- 계정 API ---------- */
  if (url.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign({
        'access-control-allow-methods':'GET,POST,OPTIONS',
        'access-control-allow-headers':'content-type,authorization' }, CORS));
      return res.end();
    }
    const done = (code, obj) => {
      res.writeHead(code, Object.assign({'content-type':'application/json; charset=utf-8'}, CORS));
      res.end(JSON.stringify(obj));
    };
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
             || req.socket.remoteAddress || '?';

    const bearer = () => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

    if (url === '/api/me') {
      auth.me(bearer())
        .then(r => r ? done(200, r) : done(401, { err: '로그인이 필요해요.' }))
        .catch(e => { console.error(e); done(500, { err: '서버에 문제가 생겼어요.' }); });
      return;
    }

    if (url === '/api/users' && req.method === 'GET') {
      auth.listUsers(bearer())
        .then(r => r.err ? done(403, r) : done(200, r))
        .catch(e => { console.error(e); done(500, { err: '서버에 문제가 생겼어요.' }); });
      return;
    }

    if ((url === '/api/signup' || url === '/api/login' || url === '/api/nick'
         || url === '/api/users/delete' || url === '/api/users/pw')
        && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', async () => {
        let b; try { b = JSON.parse(body || '{}'); } catch (e) { return done(400, { err:'잘못된 요청' }); }
        try {
          let r;
          if (url === '/api/signup')            r = await auth.signup(b.id, b.nick, b.pw, ip);
          else if (url === '/api/login')       r = await auth.login(b.id, b.pw, ip);
          else if (url === '/api/nick')        r = await auth.changeNick(bearer(), b.nick);
          else if (url === '/api/users/delete') r = await auth.removeUser(bearer(), b.id);
          else                                  r = await auth.resetPw(bearer(), b.id, b.pw);
          return r.err ? done(400, r) : done(200, r);
        } catch (e) {
          console.error(e);
          return done(500, { err: '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' });
        }
      });
      return;
    }
    return done(404, { err: '없는 주소' });
  }

  let rel = url === '/' ? '/index.html' : url;
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, {'content-type':'text/plain; charset=utf-8'});
               return res.end('없는 파일입니다'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(data);
  });
});

/* ---------------------------------------------------------
   방 관리
   --------------------------------------------------------- */
const CYCLE = 210;                 // 하루 = 낮 90초 + 밤 120초 (클라이언트와 같아야 합니다)
const SHARED_KEYS = ['wood','stick','hide','seed','clay','grass','grain',
                     'copper','tin','pillar','cap'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 헷갈리는 0·O·1·I 제외
const MAX_PLAYERS = 12;

const rooms = new Map();
let nextId = 1;

function freshShared(){ const o = {}; for (const k of SHARED_KEYS) o[k] = 0; return o; }

function makeRoom(code){
  const room = {
    code,
    players: new Map(),
    hostId: null,
    era: 0,
    started: false,        // 방장이 탐험을 시작했는가
    skyT: 0,
    shared: freshShared(),
    missions: {},
    used: new Set(),      // 이미 사용된 상호작용 번호
    boars: [],
    lastTick: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function newCode(){
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, obj){
  if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
}
function broadcast(room, obj, exceptId){
  const s = JSON.stringify(obj);
  for (const p of room.players.values()){
    if (p.id === exceptId) continue;
    if (p.ws.readyState === 1) { try { p.ws.send(s); } catch (e) {} }
  }
}
function playerList(room){
  return [...room.players.values()].map(p => ({
    id:p.id, name:p.name, color:p.color, x:p.x, z:p.z, yaw:p.yaw, dead:p.dead
  }));
}
/* 시대를 새로 시작하면 공유 상태를 초기화한다 */
function resetEra(room, era){
  room.era = era;
  room.skyT = 0;
  room.shared = freshShared();
  room.missions = {};
  room.used = new Set();
  room.boars = [];
}

/* ---------------------------------------------------------
   WebSocket
   --------------------------------------------------------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 18 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let me = null, room = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    /* ---------- 방 입장 ---------- */
    if (m.t === 'join') {
      if (me) return;
      const who = auth.whoIs(m.token);
      if (!who) return send(ws, { t:'error', msg:'로그인이 필요해요. 먼저 로그인해 주세요.' });
      const name = who.nick;
      let code = String(m.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

      if (m.create || !code) { code = newCode(); room = makeRoom(code); }
      else {
        room = rooms.get(code);
        if (!room) { return send(ws, { t:'error', msg:'그런 방이 없어요. 코드를 다시 확인해 주세요.' }); }
        if (room.players.size >= MAX_PLAYERS) {
          return send(ws, { t:'error', msg:`방이 가득 찼어요 (최대 ${MAX_PLAYERS}명).` });
        }
      }

      /* 같은 계정이 이미 그 방에 있으면 이전 연결을 끊는다 */
      for (const q of room.players.values())
        if (q.uname === who.uname) { try { q.ws.close(); } catch (e) {} }

      me = {
        id: nextId++, name, uname: who.uname, admin: who.admin, ws,
        x: 0, z: 44, yaw: 0, mov: 0, dead: false,
        color: (Math.floor(Math.random()*0xffffff) | 0x404040) & 0xdfdfdf
      };
      room.players.set(me.id, me);
      if (!room.hostId) room.hostId = me.id;

      send(ws, {
        t:'welcome', id: me.id, code: room.code, host: room.hostId === me.id,
        players: playerList(room), shared: room.shared, missions: room.missions,
        used: [...room.used], sky: room.skyT, era: room.era, started: room.started
      });
      broadcast(room, { t:'joined', player: {
        id:me.id, name:me.name, color:me.color, x:me.x, z:me.z, yaw:me.yaw, dead:false
      } }, me.id);
      broadcast(room, { t:'toast', msg:`👋 ${me.name} 님이 참가했어요` }, me.id);
      return;
    }

    if (!me || !room) return;
    const isHost = room.hostId === me.id;

    switch (m.t) {
      /* ---------- 위치 ---------- */
      case 'pos':
        me.x = +m.x || 0; me.z = +m.z || 0; me.yaw = +m.yaw || 0;
        me.mov = +m.mov || 0;
        broadcast(room, { t:'pos', id:me.id, x:me.x, z:me.z, yaw:me.yaw, mov:me.mov }, me.id);
        break;

      /* ---------- 채집물 · 제작소를 사용했다 ---------- */
      case 'act': {
        const nid = m.nid | 0;
        if (room.used.has(nid)) { send(ws, { t:'actFail', nid }); break; }
        room.used.add(nid);
        broadcast(room, { t:'act', nid, by: me.id }, me.id);
        send(ws, { t:'actOk', nid });
        break;
      }

      /* ---------- 공유 자원 증감 ---------- */
      case 'share': {
        const d = m.d || {};
        for (const k of SHARED_KEYS) {
          if (typeof d[k] === 'number' && isFinite(d[k])) {
            room.shared[k] = Math.max(0, (room.shared[k] || 0) + Math.round(d[k]));
          }
        }
        broadcast(room, { t:'shared', data: room.shared });
        send(ws, { t:'shared', data: room.shared });
        break;
      }

      /* ---------- 단계 완료 ---------- */
      case 'mission': {
        const id = String(m.id || '').slice(0, 20);
        if (!id || room.missions[id]) break;
        room.missions[id] = true;
        broadcast(room, { t:'mission', id, by: me.id }, me.id);
        break;
      }

      /* ---------- 멧돼지 (호스트가 계산해서 보낸다) ---------- */
      case 'boars':
        if (!isHost) break;
        room.boars = Array.isArray(m.list) ? m.list.slice(0, 12) : [];
        broadcast(room, { t:'boars', list: room.boars }, me.id);
        break;

      /* ---------- 공격 결과를 호스트에게 알린다 ---------- */
      case 'fx': {
        const host = room.players.get(room.hostId);
        if (host) send(host.ws, { t:'fx', by: me.id, kill: m.kill || [], stun: m.stun || [] });
        break;
      }

      /* ---------- 죽음 / 부활 ---------- */
      case 'died':
        me.dead = true;
        broadcast(room, { t:'died', id: me.id, name: me.name });
        break;
      case 'respawn':
        me.dead = false;
        broadcast(room, { t:'respawn', id: me.id }, me.id);
        break;

      /* ---------- 탐험 시작 (방장만) ---------- */
      case 'start':
        if (!isHost || room.started) break;
        room.started = true;
        broadcast(room, { t:'start' });
        break;

      /* ---------- 시대 이동 (호스트만) ---------- */
      case 'era':
        if (!isHost) break;
        resetEra(room, Math.max(0, Math.min(2, m.index | 0)));
        broadcast(room, { t:'era', index: room.era });
        break;

      /* ---------- 호스트가 하늘 시각을 맞춘다 ---------- */
      case 'sky':
        if (!isHost) break;
        room.skyT = ((+m.t || 0) % CYCLE + CYCLE) % CYCLE;
        broadcast(room, { t:'sky', t: room.skyT }, me.id);
        break;

      /* ---------- 채팅 ---------- */
      case 'chat': {
        const msg = String(m.msg || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!msg) break;
        broadcast(room, { t:'chat', from: me.name, msg }, me.id);
        break;
      }

      /* ---------- 알림 ---------- */
      case 'toast':
        broadcast(room, { t:'toast', msg: String(m.msg || '').slice(0, 80) }, me.id);
        break;
    }
  });

  ws.on('close', () => {
    if (!me || !room) return;
    room.players.delete(me.id);
    broadcast(room, { t:'left', id: me.id });
    broadcast(room, { t:'toast', msg:`👋 ${me.name} 님이 나갔어요` });

    if (room.players.size === 0) { rooms.delete(room.code); return; }
    if (room.hostId === me.id) {                    // 방장이 나가면 다음 사람에게 넘긴다
      room.hostId = room.players.keys().next().value;
      room.boars = [];
      broadcast(room, { t:'host', id: room.hostId });
      broadcast(room, { t:'toast', msg:'👑 방장이 바뀌었어요' });
    }
  });
});

/* 끊어진 연결 정리 */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

/* 방마다 시간이 흐른다 (호스트가 없어도 낮과 밤은 계속된다) */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const dt = Math.min(1, (now - room.lastTick) / 1000);
    room.lastTick = now;
    room.skyT = (room.skyT + dt) % CYCLE;
  }
}, 250);

/* 1초마다 시각을 알려 준다 (그 사이는 각자 계산) */
setInterval(() => {
  for (const room of rooms.values()) broadcast(room, { t:'sky', t: room.skyT });
}, 1000);

(async () => {
  try { await db.init(); await auth.initSecret(); }
  catch (e) { console.error('저장소 준비 실패:', e.message); }
  console.log(`계정 저장 방식 : ${db.kind}` +
    (auth.ADMIN_USER ? ` · 관리자 아이디 : ${auth.ADMIN_USER}` : ' · 관리자 : 첫 가입자'));

  /* ---------- 계정 지우기 ----------
     환경 변수 RESET_USER 에 아이디를 적어 두면 서버가 시작할 때 그 계정을 지웁니다.
     (비밀번호를 잊었을 때 쓰는 비상 수단입니다)
     같은 값으로는 한 번만 실행되므로, 지우고 나서 환경 변수를 남겨 둬도
     다음 배포 때 또 지워지지는 않습니다.
     같은 아이디를 다시 지우려면 값을 조금 바꿔 주세요 (예: admin → admin,admin). */
  try {
    const want = (process.env.RESET_USER || '').trim();
    if (want) {
      const done = await db.getConfig('reset_done');
      if (done === want) {
        console.log('· RESET_USER : 이미 처리한 값이라 건너뜁니다.');
      } else {
        for (const id of want.split(',').map(v => v.trim().toLowerCase()).filter(Boolean)) {
          const gone = await db.deleteUser(id);
          console.log(gone ? `🗑️  계정을 지웠습니다 : ${id}`
                           : `·  그런 계정이 없습니다 : ${id}`);
        }
        await db.setConfig('reset_done', want);
        console.log('⚠️  다 되었으면 Render 에서 RESET_USER 환경 변수를 지워 주세요.');
      }
    }
  } catch (e) { console.error('계정 삭제 중 문제:', e.message); }
})();

server.listen(PORT, () => {
  console.log(`역사탐험대 멀티플레이 서버 실행 중 : http://localhost:${PORT}`);
  console.log(`  · 게임      http://localhost:${PORT}/`);
  console.log(`  · 접속 주소 ws://localhost:${PORT}/ws`);
});

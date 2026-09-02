/* =========================================================
   회원가입 · 로그인
   ---------------------------------------------------------
   · 비밀번호는 scrypt 로 해시해서 저장합니다 (원문은 저장하지 않습니다)
   · 로그인하면 서명된 토큰을 주고, 이후에는 토큰으로 확인합니다
   ========================================================= */
'use strict';

const crypto = require('crypto');
const db     = require('./db');

/* 관리자로 지정할 닉네임 (Render 환경 변수 ADMIN_USER 로 지정) */
const ADMIN_USER = (process.env.ADMIN_USER || '').trim().toLowerCase();

const TOKEN_DAYS = 60;
let SECRET = null;

/* 서명 열쇠 : 환경 변수 → 저장소 → 새로 생성 순으로 확보한다 */
async function initSecret(){
  if (process.env.SESSION_SECRET) { SECRET = process.env.SESSION_SECRET; return; }
  let s = await db.getConfig('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); await db.setConfig('session_secret', s); }
  SECRET = s;
}

/* ---------------------------------------------------------
   비밀번호
   --------------------------------------------------------- */
function hashPw(pw, salt){
  return new Promise((res, rej) => {
    crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, key) =>
      e ? rej(e) : res(key.toString('hex')));
  });
}
function sameHash(a, b){
  const ba = Buffer.from(String(a), 'hex'), bb = Buffer.from(String(b), 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/* ---------------------------------------------------------
   토큰
   --------------------------------------------------------- */
function sign(payload){
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac  = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token){
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.u || (p.e && Date.now() > p.e)) return null;
    return p;
  } catch (e) { return null; }
}

/* ---------------------------------------------------------
   이름 · 비밀번호 규칙
   --------------------------------------------------------- */
const NAME_RE = /^[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ_-]{2,12}$/;
function checkName(n){
  n = String(n || '').trim();
  if (!NAME_RE.test(n)) return { err: '닉네임은 한글·영문·숫자 2~12자로 지어 주세요.' };
  return { ok: n };
}
function checkPw(p){
  p = String(p || '');
  if (p.length < 6)  return { err: '비밀번호는 6자 이상이어야 해요.' };
  if (p.length > 72) return { err: '비밀번호가 너무 깁니다.' };
  return { ok: p };
}

/* ---------------------------------------------------------
   같은 주소에서 너무 자주 시도하지 못하게
   --------------------------------------------------------- */
const hits = new Map();
function tooMany(ip){
  const now = Date.now();
  const h = hits.get(ip) || { n: 0, at: now };
  if (now - h.at > 10 * 60 * 1000) { h.n = 0; h.at = now; }
  h.n++; hits.set(ip, h);
  return h.n > 30;                       // 10분에 30번까지
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (now - h.at > 30 * 60 * 1000) hits.delete(ip);
}, 10 * 60 * 1000);

/* ---------------------------------------------------------
   기능
   --------------------------------------------------------- */
async function signup(name, pw, ip){
  if (tooMany(ip)) return { err: '잠시 후 다시 시도해 주세요.' };
  const n = checkName(name); if (n.err) return n;
  const p = checkPw(pw);     if (p.err) return p;

  const uname = n.ok.toLowerCase();
  if (await db.getUser(uname)) return { err: '이미 쓰고 있는 닉네임이에요.' };

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPw(p.ok, salt);
  /* 관리자 지정 : ADMIN_USER 와 같은 닉네임, 또는 (지정이 없다면) 첫 번째 가입자 */
  const admin = ADMIN_USER ? (uname === ADMIN_USER) : ((await db.countUsers()) === 0);

  const row = await db.createUser({ uname, disp: n.ok, hash, salt, admin });
  return session(row);
}

async function login(name, pw, ip){
  if (tooMany(ip)) return { err: '잠시 후 다시 시도해 주세요.' };
  const uname = String(name || '').trim().toLowerCase();
  const row = await db.getUser(uname);
  if (!row) return { err: '닉네임 또는 비밀번호가 올바르지 않아요.' };

  const hash = await hashPw(String(pw || ''), row.pw_salt);
  if (!sameHash(hash, row.pw_hash)) return { err: '닉네임 또는 비밀번호가 올바르지 않아요.' };

  /* 관리자 지정이 나중에 바뀌었을 수도 있으니 맞춰 준다 */
  if (ADMIN_USER) {
    const should = (uname === ADMIN_USER);
    if (!!row.is_admin !== should) { await db.setAdmin(uname, should); row.is_admin = should; }
  }
  await db.touchLogin(uname);
  return session(row);
}

function session(row){
  const admin = !!row.is_admin;
  const token = sign({
    u: row.uname, d: row.uname_disp, a: admin,
    e: Date.now() + TOKEN_DAYS * 86400000
  });
  return { token, name: row.uname_disp, admin };
}

/* 토큰으로 사용자 확인 */
function whoIs(token){
  const p = verify(token);
  if (!p) return null;
  return { uname: p.u, name: p.d || p.u, admin: !!p.a };
}

module.exports = { initSecret, signup, login, whoIs, ADMIN_USER };

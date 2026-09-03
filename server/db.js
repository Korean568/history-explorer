/* =========================================================
   계정 저장소
   ---------------------------------------------------------
   · DATABASE_URL 이 있으면 Neon(PostgreSQL) 을 씁니다
   · 없으면 server/data/users.json 파일에 저장합니다
     (교실 노트북에서 인터넷 없이 돌릴 때용)
   ========================================================= */
'use strict';

const fs   = require('fs');
const path = require('path');

const URL_ = (process.env.DATABASE_URL || '').trim();

let Pool = null;
if (URL_) {
  try { Pool = require('pg').Pool; }
  catch (e) { console.warn('⚠️  pg 모듈이 없어 파일 저장으로 넘어갑니다.'); }
}

/* ---------------------------------------------------------
   1) PostgreSQL (Neon)
   --------------------------------------------------------- */
function makePg(){
  const pool = new Pool({
    connectionString: URL_,
    ssl: { rejectUnauthorized: false },
    max: 5, idleTimeoutMillis: 30000
  });

  async function init(){
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id         SERIAL PRIMARY KEY,
        uname      TEXT UNIQUE NOT NULL,   -- 아이디 (소문자)
        uname_disp TEXT NOT NULL,          -- 아이디 (입력한 그대로)
        nick       TEXT,                   -- 닉네임 (화면에 보이는 이름)
        pw_hash    TEXT NOT NULL,
        pw_salt    TEXT NOT NULL,
        is_admin   BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login TIMESTAMPTZ
      )`);
    /* 예전 버전에서 올라온 표에도 닉네임 칸을 더한다 */
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nick TEXT`);
    await pool.query(`UPDATE users SET nick = uname_disp WHERE nick IS NULL`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      )`);
  }

  return {
    kind: 'postgres',
    init,
    async getUser(uname){
      const r = await pool.query('SELECT * FROM users WHERE uname=$1', [uname]);
      return r.rows[0] || null;
    },
    async createUser(u){
      const r = await pool.query(
        `INSERT INTO users (uname, uname_disp, nick, pw_hash, pw_salt, is_admin)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [u.uname, u.disp, u.nick, u.hash, u.salt, !!u.admin]);
      return r.rows[0];
    },
    async setNick(uname, nick){
      await pool.query('UPDATE users SET nick=$2 WHERE uname=$1', [uname, nick]);
    },
    async deleteUser(uname){
      const r = await pool.query('DELETE FROM users WHERE uname=$1', [uname]);
      return r.rowCount > 0;
    },
    async touchLogin(uname){
      await pool.query('UPDATE users SET last_login=now() WHERE uname=$1', [uname]);
    },
    async setAdmin(uname, on){
      await pool.query('UPDATE users SET is_admin=$2 WHERE uname=$1', [uname, !!on]);
    },
    async countUsers(){
      const r = await pool.query('SELECT count(*)::int AS n FROM users');
      return r.rows[0].n;
    },
    async getConfig(k){
      const r = await pool.query('SELECT v FROM config WHERE k=$1', [k]);
      return r.rows[0] ? r.rows[0].v : null;
    },
    async setConfig(k, v){
      await pool.query(
        `INSERT INTO config (k,v) VALUES ($1,$2)
         ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [k, v]);
    }
  };
}

/* ---------------------------------------------------------
   2) 파일 저장 (DATABASE_URL 이 없을 때)
   --------------------------------------------------------- */
function makeFile(){
  const dir  = path.join(__dirname, 'data');
  const file = path.join(dir, 'users.json');
  let data = { users: {}, config: {} };

  function load(){
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { data = { users: {}, config: {} }; }
    data.users  = data.users  || {};
    data.config = data.config || {};
  }
  function save(){
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e) { console.warn('계정 저장 실패:', e.message); }
  }

  return {
    kind: 'file',
    async init(){ load(); },
    async getUser(uname){ return data.users[uname] || null; },
    async createUser(u){
      const row = { uname:u.uname, uname_disp:u.disp, nick:u.nick, pw_hash:u.hash,
                    pw_salt:u.salt, is_admin:!!u.admin, created_at:new Date().toISOString() };
      data.users[u.uname] = row; save(); return row;
    },
    async setNick(uname, nick){
      if (data.users[uname]) { data.users[uname].nick = nick; save(); }
    },
    async deleteUser(uname){
      if (!data.users[uname]) return false;
      delete data.users[uname]; save(); return true;
    },
    async touchLogin(uname){
      if (data.users[uname]) { data.users[uname].last_login = new Date().toISOString(); save(); }
    },
    async setAdmin(uname, on){
      if (data.users[uname]) { data.users[uname].is_admin = !!on; save(); }
    },
    async countUsers(){ return Object.keys(data.users).length; },
    async getConfig(k){ return data.config[k] || null; },
    async setConfig(k, v){ data.config[k] = v; save(); }
  };
}

module.exports = (URL_ && Pool) ? makePg() : makeFile();

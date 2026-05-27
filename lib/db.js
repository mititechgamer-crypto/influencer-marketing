// Dual-mode DB adapter.
// - DATABASE_URL set  -> Postgres (production / Render)
// - otherwise         -> node:sqlite (local dev)
//
// Same async API both ways: query / one / many. Dialect-specific date
// expressions for the reports route are exposed as `buckets.*`.

const path = require('node:path');
const fs = require('node:fs');

const usePg = !!process.env.DATABASE_URL;

let api;

if (usePg) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
  });

  api = {
    dialect: 'pg',
    pool,
    async query(sql, params = []) {
      const res = await pool.query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount };
    },
    async one(sql, params) {
      const r = await this.query(sql, params);
      return r.rows[0] || null;
    },
    async many(sql, params) {
      const r = await this.query(sql, params);
      return r.rows;
    },
    buckets: {
      month: (col) => `to_char((${col})::date, 'YYYY-MM')`,
      quarter: (col) => `to_char((${col})::date, 'YYYY') || '-Q' || to_char((${col})::date, 'Q')`,
      year: (col) => `to_char((${col})::date, 'YYYY')`,
      yearOf: (col) => `to_char((${col})::date, 'YYYY')`
    },
    placeholder: (n) => `$${n}`,
    boolTrue: 'true',
    boolFalse: 'false',
    returningId: 'RETURNING id'
  };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const dataDir = process.env.SQLITE_DIR || path.join(__dirname, '..');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'data.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  api = {
    dialect: 'sqlite',
    db,
    async query(sql, params = []) {
      // $1, $2, ... -> ?  (SQLite-compatible)
      const converted = sql.replace(/\$(\d+)/g, '?');
      const stmt = db.prepare(converted);
      const trimmed = converted.replace(/^\s+/, '');
      const head = trimmed.slice(0, 6).toUpperCase();
      if (head === 'SELECT' || head === 'PRAGMA' || /\bRETURNING\b/i.test(converted)) {
        return { rows: stmt.all(...params), rowCount: 0 };
      }
      const info = stmt.run(...params);
      return { rows: [], rowCount: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
    },
    async one(sql, params) {
      const r = await this.query(sql, params);
      return r.rows[0] || null;
    },
    async many(sql, params) {
      const r = await this.query(sql, params);
      return r.rows;
    },
    buckets: {
      month: (col) => `strftime('%Y-%m', ${col})`,
      quarter: (col) => `strftime('%Y', ${col}) || '-Q' || ((CAST(strftime('%m', ${col}) AS INTEGER) + 2) / 3)`,
      year: (col) => `strftime('%Y', ${col})`,
      yearOf: (col) => `strftime('%Y', ${col})`
    },
    placeholder: (n) => `$${n}`,
    boolTrue: '1',
    boolFalse: '0',
    returningId: 'RETURNING id'
  };
}

module.exports = api;

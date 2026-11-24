import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,           -- Telegram user id
  username    TEXT,
  name        TEXT,
  saldo       INTEGER NOT NULL DEFAULT 0,
  banned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- Buku besar: setiap perubahan saldo tercatat
CREATE TABLE IF NOT EXISTS mutations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  amount      INTEGER NOT NULL,
  saldo_after INTEGER NOT NULL,
  type        TEXT NOT NULL,                 -- deposit | purchase | refund | admin
  ref         TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  ref_id        TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  sku           TEXT NOT NULL,
  produk        TEXT,
  tujuan        TEXT NOT NULL,
  zone          TEXT,
  harga_jual    INTEGER NOT NULL,
  harga_modal   INTEGER NOT NULL,
  -- submitting | unknown | processing | review | success | refunded | failed
  status        TEXT NOT NULL,
  invoice       TEXT,
  sn            TEXT,
  pesan         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  submitted_at  INTEGER,
  next_check_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trx_user ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trx_due  ON transactions(status, next_check_at);

CREATE TABLE IF NOT EXISTS deposits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  amount       INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | expired
  admin_id     INTEGER,
  created_at   INTEGER NOT NULL,
  processed_at INTEGER,
  proof_at     INTEGER                            -- waktu bukti transfer dikirim
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Migrasi database lama: kolom proof_at
if (!db.prepare('PRAGMA table_info(deposits)').all().some((c) => c.name === 'proof_at')) {
  db.exec('ALTER TABLE deposits ADD COLUMN proof_at INTEGER');
  // Deposit lama: tidak diketahui apakah bukti sudah dikirim → anggap sudah, agar tidak ikut kedaluwarsa
  db.exec("UPDATE deposits SET proof_at = created_at WHERE status = 'pending'");
}

export const FINAL = new Set(['success', 'refunded', 'failed']);
const PENDING = ['submitting', 'unknown', 'processing', 'review'];
const now = () => Date.now();

export class InsufficientBalance extends Error {}

export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ---------- users & saldo ---------- */

export function upsertUser(u) {
  db.prepare(
    `INSERT INTO users (id, username, name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET username = excluded.username, name = excluded.name`,
  ).run(u.id, u.username ?? null, [u.first_name, u.last_name].filter(Boolean).join(' '), now());
}

export const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

export const setBanned = (id, banned) =>
  db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, id).changes > 0;

export const activeUserIds = () =>
  db.prepare('SELECT id FROM users WHERE banned = 0').all().map((r) => r.id);

// Harus dipanggil di dalam transaction()
function applyBalance(userId, amount, type, ref = null, note = null) {
  const r =
    amount < 0
      ? db.prepare('UPDATE users SET saldo = saldo + ? WHERE id = ? AND saldo >= ?').run(amount, userId, -amount)
      : db.prepare('UPDATE users SET saldo = saldo + ? WHERE id = ?').run(amount, userId);
  if (r.changes === 0) throw new InsufficientBalance('Saldo tidak cukup');
  const { saldo } = db.prepare('SELECT saldo FROM users WHERE id = ?').get(userId);
  db.prepare(
    'INSERT INTO mutations (user_id, amount, saldo_after, type, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(userId, amount, saldo, type, ref, note, now());
  return saldo;
}

export const adjustBalance = (userId, amount, type, ref = null, note = null) =>
  transaction(() => applyBalance(userId, amount, type, ref, note));

/* ---------- transaksi ---------- */

export const getTrx = (ref) => db.prepare('SELECT * FROM transactions WHERE ref_id = ?').get(ref);

/** Potong saldo pelanggan & catat transaksi secara atomik. Melempar InsufficientBalance. */
export function createPurchase({ refId, userId, sku, produk, tujuan, zone, hargaJual, hargaModal }) {
  return transaction(() => {
    const saldo = applyBalance(userId, -hargaJual, 'purchase', refId, produk);
    const t = now();
    db.prepare(
      `INSERT INTO transactions
       (ref_id, user_id, sku, produk, tujuan, zone, harga_jual, harga_modal, status, created_at, updated_at, next_check_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitting', ?, ?, ?)`,
    ).run(refId, userId, sku, produk, tujuan, zone ?? null, hargaJual, hargaModal, t, t, t + 180_000);
    return saldo;
  });
}

const TRX_FIELDS = new Set(['status', 'invoice', 'sn', 'pesan', 'harga_modal', 'submitted_at', 'next_check_at']);

/** Update transaksi yang belum final. Mengembalikan baris terbaru. */
export function updateTrx(ref, fields) {
  const keys = Object.keys(fields).filter((k) => TRX_FIELDS.has(k));
  if (keys.length) {
    db.prepare(
      `UPDATE transactions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?
       WHERE ref_id = ? AND status NOT IN ('success','refunded','failed')`,
    ).run(...keys.map((k) => fields[k] ?? null), now(), ref);
  }
  return getTrx(ref);
}

/**
 * Tandai transaksi final (sekali saja). Bila bukan success, saldo pelanggan dikembalikan.
 * Mengembalikan baris terbaru, atau null bila sudah final sebelumnya.
 */
export function finalizeTrx(ref, status, fields = {}) {
  return transaction(() => {
    const t = getTrx(ref);
    if (!t || FINAL.has(t.status)) return null;
    const keys = Object.keys(fields).filter((k) => TRX_FIELDS.has(k) && k !== 'status' && k !== 'next_check_at');
    db.prepare(
      `UPDATE transactions SET status = ?, ${keys.map((k) => `${k} = ?, `).join('')}updated_at = ?, next_check_at = NULL
       WHERE ref_id = ?`,
    ).run(status, ...keys.map((k) => fields[k] ?? null), now(), ref);
    if (status !== 'success') applyBalance(t.user_id, t.harga_jual, 'refund', ref, t.produk);
    return getTrx(ref);
  });
}

export const dueTrx = (limit) =>
  db
    .prepare(
      `SELECT * FROM transactions WHERE status IN (${PENDING.map(() => '?').join(',')})
       AND next_check_at <= ? ORDER BY next_check_at LIMIT ?`,
    )
    .all(...PENDING, now(), limit);

export const userTrx = (userId, limit = 10) =>
  db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);

/** Transaksi yang belum final, paling lama dulu. */
export const pendingTrx = (limit = 20) =>
  db
    .prepare(
      `SELECT * FROM transactions WHERE status IN (${PENDING.map(() => '?').join(',')}) ORDER BY created_at LIMIT ?`,
    )
    .all(...PENDING, limit);

export const userMutations = (userId, limit = 10) =>
  db.prepare('SELECT * FROM mutations WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);

/* ---------- deposit ---------- */

export function createDeposit(userId, amount) {
  return Number(
    db.prepare('INSERT INTO deposits (user_id, amount, created_at) VALUES (?, ?, ?)').run(userId, amount, now())
      .lastInsertRowid,
  );
}

export const getDeposit = (id) => db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);

export const pendingDeposits = () =>
  db.prepare("SELECT * FROM deposits WHERE status = 'pending' ORDER BY id").all();

export const countPendingDeposits = (userId) =>
  db.prepare("SELECT COUNT(*) AS n FROM deposits WHERE user_id = ? AND status = 'pending'").get(userId).n;

/**
 * Deposit terbaru milik user yang belum ada bukti transfernya (masih menunggu, atau kedaluwarsa ≤ 7 hari).
 * Dipakai saat pelanggan mengirim bukti di luar sesi (mis. kembali lebih dari 15 menit kemudian).
 */
export const depositAwaitingProof = (userId) =>
  db
    .prepare(
      `SELECT * FROM deposits WHERE user_id = ? AND proof_at IS NULL AND status IN ('pending','expired')
       AND created_at > ? ORDER BY id DESC LIMIT 1`,
    )
    .get(userId, now() - 7 * 86_400_000);

/** Catat bukti transfer; deposit yang sempat kedaluwarsa dibuka kembali. */
export const markDepositProof = (id) =>
  db
    .prepare(
      "UPDATE deposits SET proof_at = ?, status = 'pending', processed_at = NULL WHERE id = ? AND status IN ('pending','expired')",
    )
    .run(now(), id).changes > 0;

/** Tandai kedaluwarsa deposit tanpa bukti yang lebih lama dari maxAgeMs. Mengembalikan baris yang diubah. */
export function expireDeposits(maxAgeMs) {
  return transaction(() => {
    const rows = db
      .prepare("SELECT * FROM deposits WHERE status = 'pending' AND proof_at IS NULL AND created_at < ?")
      .all(now() - maxAgeMs);
    const upd = db.prepare("UPDATE deposits SET status = 'expired', processed_at = ? WHERE id = ? AND status = 'pending'");
    for (const d of rows) upd.run(now(), d.id);
    return rows;
  });
}

/**
 * approve=true menambah saldo. Mengembalikan { dep, saldo } atau null bila sudah diproses.
 * Deposit kedaluwarsa masih bisa diterima/ditolak admin (mis. bila dana ternyata masuk).
 */
export function processDeposit(id, adminId, approve) {
  return transaction(() => {
    const r = db
      .prepare(
        "UPDATE deposits SET status = ?, admin_id = ?, processed_at = ? WHERE id = ? AND status IN ('pending','expired')",
      )
      .run(approve ? 'approved' : 'rejected', adminId, now(), id);
    if (r.changes === 0) return null;
    const dep = getDeposit(id);
    const saldo = approve
      ? applyBalance(dep.user_id, dep.amount, 'deposit', `DEP${id}`, 'Deposit disetujui')
      : getUser(dep.user_id)?.saldo;
    return { dep, saldo };
  });
}

/* ---------- settings & statistik ---------- */

export function getSetting(key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

export const setSetting = (key, value) =>
  db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));

// Zona WIB (UTC+7): semua "hari ini / bulan ini" dihitung menurut WIB, bukan zona waktu server
const WIB = 7 * 3600_000;

/** Awal hari WIB (ms), daysAgo = 0 berarti hari ini. */
export function startOfDayWib(daysAgo = 0) {
  const d = new Date(Date.now() + WIB);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - WIB - daysAgo * 86_400_000;
}

/** Awal bulan WIB (ms). */
export function startOfMonthWib() {
  const d = new Date(Date.now() + WIB);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - WIB;
}

/** Rekap sejak `since` (ms): per hari (WIB), total, produk terlaris, deposit. */
export function report(since) {
  const day = `strftime('%Y-%m-%d', created_at / 1000 + ${WIB / 1000}, 'unixepoch')`;
  return {
    days: db
      .prepare(
        `SELECT ${day} AS hari, COUNT(*) AS n, SUM(harga_jual) AS omzet, SUM(harga_jual - harga_modal) AS laba
         FROM transactions WHERE status = 'success' AND created_at >= ? GROUP BY hari ORDER BY hari`,
      )
      .all(since),
    total: db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(harga_jual),0) AS omzet, COALESCE(SUM(harga_jual - harga_modal),0) AS laba
         FROM transactions WHERE status = 'success' AND created_at >= ?`,
      )
      .get(since),
    gagal: db
      .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE status IN ('refunded','failed') AND created_at >= ?`)
      .get(since).n,
    top: db
      .prepare(
        `SELECT produk, COUNT(*) AS n, SUM(harga_jual - harga_modal) AS laba FROM transactions
         WHERE status = 'success' AND created_at >= ? GROUP BY produk ORDER BY n DESC LIMIT 5`,
      )
      .all(since),
    deposit: db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM deposits
         WHERE status = 'approved' AND processed_at >= ?`,
      )
      .get(since),
    userBaru: db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?').get(since).n,
  };
}

/** Salin database ke file baru (aman walau bot sedang berjalan). */
export function backupTo(file) {
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}

export function stats() {
  const since = startOfDayWib();
  return {
    users: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(saldo),0) AS saldo FROM users').get(),
    today: db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(harga_jual),0) AS omzet,
                COALESCE(SUM(harga_jual - harga_modal),0) AS laba
         FROM transactions WHERE status = 'success' AND created_at >= ?`,
      )
      .get(since.getTime()),
    pending: db
      .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE status IN (${PENDING.map(() => '?').join(',')})`)
      .get(...PENDING).n,
  };
}

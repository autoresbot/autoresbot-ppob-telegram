// Reset bot ke kondisi baru: hapus database & gambar QRIS. File .env TIDAK disentuh.
//
//   npm run reset                 → tanya konfirmasi, backup dulu, lalu reset
//   npm run reset -- --semua      → juga hapus semua backup (benar-benar dari nol, tanpa backup)
//   npm run reset -- --yes        → tanpa pertanyaan konfirmasi (untuk skrip)
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';

process.chdir(path.join(import.meta.dirname, '..'));
try {
  process.loadEnvFile();
} catch {
  // .env opsional
}

const args = new Set(process.argv.slice(2));
const ALL = args.has('--semua') || args.has('--all');
const YES = args.has('--yes') || args.has('-y');

const env = (k, d) => process.env[k]?.trim() || d;
const DB = path.resolve(env('DB_PATH', './data/bot.db'));
const QRIS = path.resolve(env('QRIS_PATH', './assets/qris.jpg'));
const BACKUP_DIR = path.resolve(env('BACKUP_DIR', './data/backup'));
const PID_FILE = path.join(path.dirname(DB), 'bot.pid');

const exists = (f) => fs.existsSync(f);
const rel = (f) => path.relative(process.cwd(), f) || f;
const fail = (msg) => {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
};

/* ---------- 1. Bot tidak boleh sedang berjalan ---------- */
if (exists(PID_FILE)) {
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = pid > 0 && pid !== process.pid;
  } catch (e) {
    alive = e.code === 'EPERM'; // proses ada, tapi milik user lain
  }
  if (alive) fail(`Bot sedang berjalan (PID ${pid}). Hentikan dulu (Ctrl+C / pm2 stop ppob-bot), lalu ulangi.`);
  fs.rmSync(PID_FILE, { force: true }); // sisa dari bot yang mati mendadak
}

/* ---------- 2. Daftar yang akan dihapus ---------- */
const dbFiles = [DB, `${DB}-wal`, `${DB}-shm`].filter(exists);
const qrisFiles = [QRIS, `${QRIS}.tmp`].filter(exists);
const backups = exists(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : [];

if (!dbFiles.length && !qrisFiles.length && !(ALL && backups.length)) {
  console.log('✅ Sudah dalam kondisi baru, tidak ada yang perlu dihapus.');
  process.exit(0);
}

let summary = '';
if (exists(DB)) {
  try {
    const db = new DatabaseSync(DB, { readOnly: true });
    const n = (t) => {
      try {
        return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      } catch {
        return 0;
      }
    };
    const saldo = (() => {
      try {
        return db.prepare('SELECT COALESCE(SUM(saldo),0) AS s FROM users').get().s;
      } catch {
        return 0;
      }
    })();
    summary =
      `   isi: ${n('users')} pelanggan (total saldo Rp${Number(saldo).toLocaleString('id-ID')}), ` +
      `${n('transactions')} transaksi, ${n('deposits')} deposit, pengaturan markup & teks pembayaran`;
    db.close();
  } catch {
    // database rusak / tidak bisa dibaca: tetap boleh dihapus
  }
}

console.log('\n⚠️  RESET BOT KE KONDISI BARU\n');
console.log('Akan dihapus:');
for (const f of dbFiles) console.log(`   • ${rel(f)}`);
if (summary) console.log(summary);
for (const f of qrisFiles) console.log(`   • ${rel(f)}  (gambar QRIS)`);
if (ALL && backups.length) console.log(`   • ${rel(BACKUP_DIR)}/  (${backups.length} file backup)`);
console.log('\nTidak disentuh: .env, assets/qris-contoh.jpg, kode program.');
console.log(
  ALL
    ? '\n‼️  Mode --semua: TIDAK ada backup. Data tidak bisa dikembalikan.'
    : `\nSebelum dihapus, data disalin ke ${rel(BACKUP_DIR)}/sebelum-reset-*.`,
);

/* ---------- 3. Konfirmasi ---------- */
if (!YES) {
  if (!process.stdin.isTTY) fail('Butuh konfirmasi. Jalankan di terminal, atau tambahkan --yes.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\nKetik RESET untuk melanjutkan: ')).trim();
  rl.close();
  if (answer !== 'RESET') {
    console.log('Dibatalkan, tidak ada yang dihapus.');
    process.exit(0);
  }
}

/* ---------- 4. Backup pengaman ---------- */
if (!ALL) {
  const stamp = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (exists(DB)) {
    const out = path.join(BACKUP_DIR, `sebelum-reset-${stamp}.db`);
    try {
      fs.rmSync(out, { force: true });
      const db = new DatabaseSync(DB);
      db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`); // termasuk isi file -wal
      db.close();
      console.log(`💾 Backup database: ${rel(out)}`);
    } catch (e) {
      fail(`Backup gagal (${e.message}). Reset dibatalkan, tidak ada yang dihapus.`);
    }
  }
  if (exists(QRIS)) {
    const out = path.join(BACKUP_DIR, `sebelum-reset-${stamp}-qris${path.extname(QRIS)}`);
    fs.copyFileSync(QRIS, out);
    console.log(`💾 Backup QRIS:    ${rel(out)}`);
  }
}

/* ---------- 5. Hapus ---------- */
try {
  for (const f of [...dbFiles, ...qrisFiles]) fs.rmSync(f, { force: true });
  if (ALL) fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
} catch (e) {
  fail(`Gagal menghapus (${e.message}). Pastikan bot sudah dihentikan, lalu ulangi.`);
}

console.log('\n✅ Reset selesai. Jalankan `npm start`, maka database baru dibuat otomatis.');
console.log('   Lalu atur ulang data pembayaran dengan /setqris dan /setpayment, serta /markup bila perlu.\n');

// Tugas berkala: backup database harian & kedaluwarsa deposit tanpa bukti
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './db.js';
import { esc, rp } from './format.js';

export const BACKUP_DIR = path.resolve(config.backupDir);
const FILE_RE = /^bot-(\d{8})-(\d{4})\.db$/;

/** YYYYMMDD dan HHmm menurut WIB */
function wibStamp() {
  const iso = new Date(Date.now() + 7 * 3600_000).toISOString(); // 2026-11-24T13:05:...
  return { date: iso.slice(0, 10).replace(/-/g, ''), time: iso.slice(11, 16).replace(':', '') };
}

const backupFiles = () =>
  fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => FILE_RE.test(f)).sort().reverse() : [];

/** Buat backup sekarang. Mengembalikan path file. */
export function createBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const { date, time } = wibStamp();
  const file = path.join(BACKUP_DIR, `bot-${date}-${time}.db`);
  if (fs.existsSync(file)) fs.unlinkSync(file); // VACUUM INTO menolak file yang sudah ada
  store.backupTo(file);
  // Simpan hanya BACKUP_KEEP file terbaru (minimal 1, file yang baru dibuat)
  for (const old of backupFiles().slice(Math.max(1, config.backupKeep))) {
    fs.unlinkSync(path.join(BACKUP_DIR, old));
  }
  return file;
}

export function startJobs(worker) {
  // Backup: dicek tiap jam, dibuat bila hari ini (WIB) belum ada backup
  if (config.backupKeep > 0) {
    const runBackup = () => {
      try {
        const today = wibStamp().date;
        if (!backupFiles().some((f) => f.startsWith(`bot-${today}-`))) {
          console.log(`[backup] ${createBackup()}`);
        }
      } catch (e) {
        console.error('[backup] gagal:', e.message);
        worker.alertAdmins(`⚠️ <b>Backup database gagal</b>\n${esc(e.message)}`);
      }
    };
    runBackup();
    setInterval(runBackup, 3600_000).unref();
  }

  // Deposit tanpa bukti transfer → kedaluwarsa (dicek tiap 10 menit)
  if (config.depositExpireHours > 0) {
    const runExpire = () => {
      try {
        for (const d of store.expireDeposits(config.depositExpireHours * 3600_000)) {
          worker.send(
            d.user_id,
            `⌛ Deposit #${d.id} sebesar ${rp(d.amount)} kedaluwarsa karena bukti transfer belum dikirim.\n` +
              `Bila Anda <b>sudah transfer</b>, kirim foto bukti transfer di chat ini.`,
          );
        }
      } catch (e) {
        console.error('[deposit] gagal memproses kedaluwarsa:', e.message);
      }
    };
    runExpire();
    setInterval(runExpire, 10 * 60_000).unref();
  }
}

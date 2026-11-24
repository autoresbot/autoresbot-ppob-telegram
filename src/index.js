import fs from 'node:fs';
import path from 'node:path';
import { Telegraf } from 'telegraf';
import { config, VERSION } from './config.js';
import './db.js';
import * as catalog from './catalog.js';
import { createWorker } from './worker.js';
import { registerHandlers } from './bot.js';
import { startJobs } from './jobs.js';
import { apiProblemHtml } from './errors.js';
import { configComplete, setupReportText, setupReportHtml } from './setup.js';

// Penanda bot sedang berjalan (dipakai `npm run reset` agar tidak menghapus database yang sedang dipakai)
const PID_FILE = path.join(path.dirname(path.resolve(config.dbPath)), 'bot.pid');
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8') === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch {
    // sudah terhapus
  }
});

const bot = new Telegraf(config.botToken, { handlerTimeout: 60_000 });
const worker = createWorker(bot);
const { commands } = registerHandlers(bot, worker);

console.log(setupReportText());

// Beri tahu admin saat koneksi ke Autoresbot bermasalah (sekali per jenis error) dan saat pulih
catalog.onStatusChange((err) =>
  worker.alertAdmins(
    err
      ? apiProblemHtml(err) + '\n\n<i>Pelanggan melihat "produk belum tersedia". Bot mencoba lagi otomatis tiap 1 menit.</i>'
      : `✅ <b>Koneksi ke Autoresbot pulih</b>\n${catalog.categories().length} kategori produk siap dijual.`,
  ),
);
catalog.startAutoRefresh();
worker.start();
startJobs(worker);

bot
  .launch(() => {
    console.log(`🤖 ${config.storeName} v${VERSION} berjalan${configComplete() ? '' : ' (konfigurasi belum lengkap)'}`);
    bot.telegram.setMyCommands(commands).catch(() => {});
    // Beri tahu admin bila konfigurasi belum selesai
    if (!configComplete()) worker.alertAdmins(setupReportHtml());
  })
  .catch((err) => {
    console.error('Gagal menjalankan bot:', err.message);
    process.exit(1);
  });

// Hentikan polling & worker lalu keluar (tanpa ini proses tetap hidup karena interval worker)
const shutdown = (signal) => {
  worker.stop();
  bot.stop(signal);
  setTimeout(() => process.exit(0), 1_000).unref();
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

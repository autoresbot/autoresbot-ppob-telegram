import { Telegraf } from 'telegraf';
import { config, VERSION } from './config.js';
import './db.js';
import * as catalog from './catalog.js';
import { createWorker } from './worker.js';
import { registerHandlers } from './bot.js';
import { startJobs } from './jobs.js';
import { configComplete, setupReportText, setupReportHtml } from './setup.js';

const bot = new Telegraf(config.botToken, { handlerTimeout: 60_000 });
const worker = createWorker(bot);
const { commands } = registerHandlers(bot, worker);

console.log(setupReportText());

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

import process from 'node:process';

try {
  process.loadEnvFile();
} catch {
  // .env opsional bila variabel sudah diset di environment
}

// Nilai contoh dari .env.example dianggap belum diisi
const PLACEHOLDER = /x{4}|nama anda|^123456789$|^123456:ABC/i;

const val = (key) => {
  const v = process.env[key]?.trim() ?? '';
  return v && !PLACEHOLDER.test(v) ? v : '';
};

const num = (key, def) => {
  const raw = process.env[key]?.trim();
  const v = Number(raw);
  return raw && Number.isFinite(v) ? v : def;
};

/* ---------- BOT_TOKEN: satu-satunya yang wajib agar bot bisa jalan ---------- */
const botToken = val('BOT_TOKEN');
if (!/^\d+:[\w-]{20,}$/.test(botToken)) {
  console.error(
    '\n❌ BOT_TOKEN belum diisi / tidak valid.\n' +
      '   Buat bot di @BotFather, lalu isi BOT_TOKEN di file .env (lihat .env.example).\n',
  );
  process.exit(1);
}

export const config = {
  botToken,
  apiKey: val('AUTORESBOT_APIKEY'),
  adminIds: val('ADMIN_IDS')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0),
  storeName: process.env.STORE_NAME?.trim() || 'PPOB Store',
  markupFlat: num('MARKUP_FLAT', 500),
  markupPercent: num('MARKUP_PERCENT', 0),
  roundTo: Math.max(1, num('ROUND_TO', 50)),
  minDeposit: num('MIN_DEPOSIT', 10000),
  maxDeposit: num('MAX_DEPOSIT', 5000000),
  depositInfo: val('DEPOSIT_INFO').replace(/\\n/g, '\n'),
  qrisPath: process.env.QRIS_PATH?.trim() || './assets/qris.jpg',
  dbPath: process.env.DB_PATH?.trim() || './data/bot.db',
  // Deposit tanpa bukti transfer otomatis kedaluwarsa setelah sekian jam (0 = tidak pernah)
  depositExpireHours: Math.max(0, num('DEPOSIT_EXPIRE_HOURS', 24)),
  // Maksimal deposit "menunggu" per pelanggan (anti-spam)
  maxPendingDeposit: Math.max(1, num('MAX_PENDING_DEPOSIT', 3)),
  // Backup otomatis harian; BACKUP_KEEP = jumlah file disimpan (0 = nonaktif)
  backupDir: process.env.BACKUP_DIR?.trim() || './data/backup',
  backupKeep: Math.max(0, num('BACKUP_KEEP', 7)),
};

export const isAdmin = (id) => config.adminIds.includes(Number(id));

/* ---------- konfigurasi statis yang belum lengkap (data pembayaran dicek di setup.js) ---------- */

export const staticIssues = [];
if (!config.apiKey) {
  staticIssues.push({
    key: 'AUTORESBOT_APIKEY',
    message: 'API key Autoresbot belum diisi (Dashboard → Akun → API Key)',
    impact: 'Katalog produk & transaksi pembelian dinonaktifkan',
  });
}
if (!config.adminIds.length) {
  staticIssues.push({
    key: 'ADMIN_IDS',
    message: 'ID Telegram admin belum diisi (cek ID di @userinfobot)',
    impact: 'Deposit tidak bisa dikonfirmasi & tidak ada notifikasi admin',
  });
}
if (config.minDeposit > config.maxDeposit) {
  staticIssues.push({
    key: 'MIN_DEPOSIT / MAX_DEPOSIT',
    message: 'MIN_DEPOSIT lebih besar dari MAX_DEPOSIT',
    impact: 'Fitur deposit dinonaktifkan',
  });
}

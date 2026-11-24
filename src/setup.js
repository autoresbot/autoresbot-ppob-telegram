// Status kelengkapan konfigurasi (dicek langsung, ikut berubah saat QRIS / teks pembayaran diganti)
import { config, staticIssues } from './config.js';
import { hasPayment } from './payment.js';
import { esc } from './format.js';

export function getSetupIssues() {
  const list = [...staticIssues];
  if (!hasPayment()) {
    list.push({
      key: 'DEPOSIT_INFO / QRIS',
      message: 'Data pembayaran belum diatur (teks rekening/e-wallet atau gambar QRIS)',
      impact: 'Fitur deposit dinonaktifkan — atur lewat /setqris atau /setpayment',
    });
  }
  return list;
}

export const isReady = {
  transaksi: () => Boolean(config.apiKey),
  deposit: () => config.adminIds.length > 0 && config.minDeposit <= config.maxDeposit && hasPayment(),
};

export const configComplete = () => getSetupIssues().length === 0;

/** Ringkasan teks polos untuk konsol. */
export function setupReportText() {
  const issues = getSetupIssues();
  if (!issues.length) return '✅ Konfigurasi lengkap.';
  return [
    '⚠️  KONFIGURASI BELUM SELESAI — bot tetap berjalan dengan fitur terbatas:',
    ...issues.map((i) => `   • ${i.key}: ${i.message}\n     → ${i.impact}`),
    '   Lengkapi file .env lalu restart bot (data pembayaran bisa diatur dari Telegram).',
  ].join('\n');
}

/** Laporan konfigurasi untuk admin (HTML). */
export function setupReportHtml() {
  const issues = getSetupIssues();
  if (!issues.length) return '✅ <b>Konfigurasi lengkap</b> — semua fitur aktif.';
  return (
    `⚙️ <b>Konfigurasi belum selesai</b>\nBot berjalan dengan fitur terbatas.\n\n` +
    issues.map((i) => `• <code>${esc(i.key)}</code>: ${esc(i.message)}\n   → <i>${esc(i.impact)}</i>`).join('\n') +
    `\n\nLengkapi file <code>.env</code> lalu restart bot. Data pembayaran bisa diatur langsung dengan /setqris dan /setpayment.`
  );
}

// Pesan ramah untuk pelanggan berdasarkan error.code dari API
const MESSAGES = {
  INVALID_REQUEST: 'Data pesanan tidak valid.',
  INVALID_DESTINATION: 'Nomor / ID tujuan tidak valid. Periksa kembali.',
  INVALID_REF_ID: 'Terjadi kesalahan sistem (ref).',
  INVALID_JSON: 'Terjadi kesalahan sistem.',
  UNAUTHORIZED: 'Layanan sedang gangguan, coba lagi nanti.',
  INSUFFICIENT_BALANCE: 'Stok sedang kosong, coba lagi beberapa saat lagi.',
  ACCOUNT_INACTIVE: 'Layanan sedang gangguan, coba lagi nanti.',
  IP_NOT_WHITELISTED: 'Layanan sedang gangguan, coba lagi nanti.',
  PRODUCT_NOT_FOUND: 'Produk tidak ditemukan.',
  TRANSACTION_NOT_FOUND: 'Pesanan gagal dikirim ke server.',
  PRICE_CHANGED: 'Harga produk baru saja berubah. Silakan ulangi pembelian dengan harga terbaru.',
  REF_ID_CONFLICT: 'Terjadi kesalahan sistem (ref).',
  DUPLICATE_TRANSACTION:
    'Produk yang sama ke nomor yang sama baru saja dibeli. Tunggu ±2 menit (untuk produk tertentu: besok) lalu coba lagi.',
  PRODUCT_UNAVAILABLE: 'Produk sedang gangguan / stok habis.',
  CUT_OFF: 'Sedang cut off harian (23.30–00.30 WIB). Silakan coba lagi setelah 00.30 WIB.',
  API_DISABLED: 'Layanan sedang tidak tersedia, coba lagi nanti.',
  SERVICE_CLOSED: 'Layanan sedang tutup, coba lagi nanti.',
  BUSY: 'Server sedang sibuk, coba lagi nanti.',
  SERVICE_UNAVAILABLE: 'Layanan sedang tidak tersedia, coba lagi nanti.',
  RATE_LIMITED: 'Server sedang sibuk, coba lagi sebentar lagi.',
};

export const friendlyError = (err) => MESSAGES[err?.code] || 'Transaksi gagal diproses.';

const escHtml = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Langkah perbaikan untuk pemilik bot berdasarkan error.code (HTML). */
export function adminAction(err) {
  const ip = String(err?.message ?? '').match(/\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[0-9a-f]*:[0-9a-f:]+\b/i)?.[0];
  switch (err?.code) {
    case 'IP_NOT_WHITELISTED':
      return (
        `Tambahkan IP <code>${escHtml(ip ?? 'server bot')}</code> di Dashboard Autoresbot › <b>REST API › Whitelist IP</b> (maks. 10 IP).` +
        `\nBila bot pindah server / IP berubah, daftarkan IP yang baru.`
      );
    case 'UNAUTHORIZED':
      return 'API key salah. Salin ulang dari Dashboard Autoresbot › <b>Akun › API Key</b> ke <code>AUTORESBOT_APIKEY</code> di <code>.env</code> (tanpa kutip/spasi), lalu restart bot.';
    case 'ACCOUNT_INACTIVE':
      return 'Akun Autoresbot belum verifikasi email atau diblokir. Cek akun di dashboard Autoresbot.';
    case 'API_DISABLED':
      return 'API Pulsa &amp; Game sedang dinonaktifkan. Aktifkan di dashboard / hubungi Autoresbot.';
    case 'INSUFFICIENT_BALANCE':
      return 'Saldo pusat Autoresbot kurang. Isi saldo di dashboard Autoresbot.';
    case 'CUT_OFF':
      return 'Sedang cut off harian (23.30–00.30 WIB). Tidak perlu tindakan, bot mencoba lagi otomatis.';
    case 'RATE_LIMITED':
    case 'BUSY':
    case 'SERVICE_CLOSED':
    case 'SERVICE_UNAVAILABLE':
    case 'INTERNAL_ERROR':
      return 'Server Autoresbot sedang sibuk/gangguan. Biasanya pulih sendiri; bot mencoba lagi otomatis.';
    case 'NETWORK_ERROR':
    case 'INVALID_RESPONSE':
      return 'Server bot tidak bisa terhubung ke autoresbot.com. Periksa koneksi internet / DNS / firewall server.';
    default:
      return 'Cek pesan error di atas dan log bot. Coba /refresh setelah diperbaiki.';
  }
}

/** Ringkasan masalah koneksi API untuk admin (HTML). */
export const apiProblemHtml = (err, title = 'Gagal memuat produk dari Autoresbot') =>
  `⚠️ <b>${title}</b>\n` +
  `Kode: <code>${escHtml(err?.code ?? 'UNKNOWN')}</code>\n` +
  `${escHtml(err?.message ?? '')}\n\n` +
  `👉 <b>Tindakan:</b> ${adminAction(err)}`;

// Error yang butuh tindakan pemilik bot (bukan salah pelanggan)
export const ADMIN_ALERT_CODES = new Set([
  'UNAUTHORIZED',
  'INSUFFICIENT_BALANCE',
  'ACCOUNT_INACTIVE',
  'IP_NOT_WHITELISTED',
  'API_DISABLED',
  'REF_ID_CONFLICT',
  'INVALID_REF_ID',
  'INVALID_JSON',
  'PAYLOAD_TOO_LARGE',
]);

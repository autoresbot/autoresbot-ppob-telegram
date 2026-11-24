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

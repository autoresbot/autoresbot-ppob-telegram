export const esc = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');

export const fmtDate = (ms) =>
  new Date(ms).toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export const STATUS_LABEL = {
  submitting: '⏳ Diproses',
  unknown: '⏳ Diproses',
  processing: '⏳ Diproses',
  review: '🔎 Diperiksa',
  success: '✅ Sukses',
  refunded: '❌ Gagal (refund)',
  failed: '❌ Gagal (refund)',
};

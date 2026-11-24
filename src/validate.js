// Validasi & normalisasi tujuan sesuai "Format tujuan" di dokumentasi API

export const HINTS = {
  phone: 'Kirim <b>nomor HP</b> tujuan.\nContoh: <code>081234567890</code>',
  pln: 'Kirim <b>nomor meter / ID pelanggan PLN</b> (11–12 digit).\nContoh: <code>12345678901</code>',
  zone: 'Kirim <b>User ID</b> dan <b>Zone ID</b> dipisah spasi.\nContoh: <code>12345678 1234</code>',
  other: 'Kirim <b>ID tujuan</b> (User ID game / nomor pelanggan).\nContoh: <code>5123456789</code>',
};

export function normalizePhone(input) {
  let s = input.replace(/[\s-]/g, '');
  if (s.startsWith('+62')) s = '0' + s.slice(3);
  else if (s.startsWith('62')) s = '0' + s.slice(2);
  return s;
}

/** Mengembalikan { tujuan, zone } atau { error } */
export function parseTujuan(text, kind, needZone) {
  const input = text.trim();

  if (needZone) {
    const m = input.match(/^(\d{3,20})\s*[\s(,|/:]\s*(\d{1,10})\)?$/);
    if (!m) return { error: 'Format salah. ' + HINTS.zone };
    return { tujuan: m[1], zone: m[2] };
  }

  if (kind === 'phone') {
    const phone = normalizePhone(input);
    if (!/^0\d{9,13}$/.test(phone)) return { error: 'Nomor HP tidak valid (diawali 0, 10–14 digit). ' + HINTS.phone };
    return { tujuan: phone };
  }

  if (kind === 'pln') {
    const meter = input.replace(/[\s-]/g, '');
    if (!/^\d{11,12}$/.test(meter)) return { error: 'Nomor meter / ID pelanggan harus 11–12 digit angka.' };
    return { tujuan: meter };
  }

  if (!/^[A-Za-z0-9._|-]{3,40}$/.test(input)) {
    return { error: 'ID tujuan tidak valid (3–40 karakter: huruf, angka, . _ | -).' };
  }
  return { tujuan: input };
}

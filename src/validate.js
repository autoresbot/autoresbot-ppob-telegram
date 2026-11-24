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

const escHtml = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Kompilasi pola dari API; null bila tidak valid. */
function compile(pola) {
  try {
    return pola ? new RegExp(pola) : null;
  } catch {
    return null;
  }
}

/**
 * Normalisasi isian dari GET /produk/:sku → [{ nama, label, re, contoh, phone }] atau null bila tidak bisa dipakai.
 * Hanya mendukung field "tujuan" (wajib) dan "zone" (opsional) sesuai body POST /transaksi.
 */
export function normalizeIsian(isian) {
  if (!Array.isArray(isian) || !isian.length) return null;
  const fields = isian.map((f) => ({
    nama: f?.nama,
    label: f?.label || f?.nama,
    pola: f?.pola,
    contoh: String(f?.contoh ?? '').replace(/^contoh\s*/i, ''),
    phone: /^\^0/.test(f?.pola ?? ''), // pola nomor HP → +62/62 dinormalkan ke 0
    // Pola hanya angka (mis. nomor meter ^[0-9]{11,12}$) → spasi/strip pemisah boleh dibuang
    digits: /^\^\[0-9\]\{\d+(,\d+)?\}\$$/.test(f?.pola ?? ''),
  }));
  if (fields[0].nama !== 'tujuan' || fields.some((f) => !['tujuan', 'zone'].includes(f.nama) || !compile(f.pola))) {
    return null;
  }
  return fields;
}

/** Petunjuk isian untuk pelanggan, berdasarkan isian API. */
export function isianHint(fields) {
  if (fields.length === 1) {
    const f = fields[0];
    return `Kirim <b>${escHtml(f.label)}</b>.` + (f.contoh ? `\nContoh: <code>${escHtml(f.contoh)}</code>` : '');
  }
  const labels = fields.map((f) => `<b>${escHtml(f.label)}</b>`).join(' dan ');
  const contoh = fields.map((f) => f.contoh.match(/[\w.|-]+/)?.[0] || '…').join(' ');
  return `Kirim ${labels} dipisah spasi.\nContoh: <code>${escHtml(contoh)}</code>`;
}

/** Validasi memakai pola resmi dari API. Mengembalikan { tujuan, zone } atau { error }. */
export function parseByIsian(text, fields) {
  const input = text.trim();
  let parts;
  if (fields.length === 1) {
    parts = [input];
  } else {
    // "12345678 1234", "12345678(1234)", "12345678|1234", "12345678,1234"
    const m = input.match(/^(\S+?)\s*[\s(,|/:]\s*(\S+?)\)?$/);
    if (!m) return { error: 'Format salah. ' + isianHint(fields) };
    parts = [m[1], m[2]];
  }
  const out = {};
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const p = parts[i].trim();
    // Nomor HP: +62/62 → 0. Field khusus angka: buang spasi/strip. Selain itu apa adanya (tidak digabung diam-diam).
    const v = f.phone ? normalizePhone(p) : f.digits && /^[\d\s-]+$/.test(p) ? p.replace(/[\s-]/g, '') : p;
    if (!compile(f.pola).test(v)) {
      return {
        error:
          `${escHtml(f.label)} tidak valid.` +
          (/\s/.test(v) ? ' Jangan pakai spasi.' : '') +
          (f.contoh ? ` Contoh: <code>${escHtml(f.contoh)}</code>` : ''),
      };
    }
    out[f.nama] = v;
  }
  return { tujuan: out.tujuan, zone: out.zone };
}

/** Validasi cadangan (bila detail produk dari API tidak tersedia). Mengembalikan { tujuan, zone } atau { error } */
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

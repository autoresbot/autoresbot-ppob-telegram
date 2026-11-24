// Data pembayaran deposit: teks (rekening / e-wallet) + gambar QRIS
import fs from 'node:fs';
import path from 'node:path';
import { Input } from 'telegraf';
import { config } from './config.js';
import * as store from './db.js';

export const QRIS_PATH = path.resolve(config.qrisPath);

/** Teks pembayaran: diatur lewat /setpayment (database), bila kosong pakai DEPOSIT_INFO di .env */
export const paymentText = () => store.getSetting('deposit_info', '') || config.depositInfo;
export const setPaymentText = (text) => store.setSetting('deposit_info', text);

export const hasQris = () => fs.existsSync(QRIS_PATH);
export const hasPayment = () => Boolean(paymentText()) || hasQris();

// Cache file_id Telegram agar gambar tidak di-upload ulang tiap kali (reset bila file diganti)
let cache = null; // { mtimeMs, size, fileId }

/** Kirim gambar QRIS. File di disk bisa diganti kapan saja tanpa restart. */
export async function sendQris(telegram, chatId, caption, extra = {}) {
  const st = fs.statSync(QRIS_PATH);
  const fresh = cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size;
  const msg = await telegram.sendPhoto(chatId, fresh ? cache.fileId : Input.fromLocalFile(QRIS_PATH), {
    caption,
    parse_mode: 'HTML',
    ...extra,
  });
  cache = { mtimeMs: st.mtimeMs, size: st.size, fileId: msg.photo.at(-1).file_id };
  return msg;
}

/** Simpan gambar QRIS baru dari file Telegram (dipakai /setqris). */
export async function saveQrisFromTelegram(telegram, fileId) {
  const url = await telegram.getFileLink(fileId);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Gagal mengunduh gambar (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(QRIS_PATH), { recursive: true });
  const tmp = QRIS_PATH + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, QRIS_PATH);
  const st = fs.statSync(QRIS_PATH);
  cache = { mtimeMs: st.mtimeMs, size: st.size, fileId }; // langsung pakai file_id yang sama
  return buf.length;
}

export function deleteQris() {
  if (!hasQris()) return false;
  fs.unlinkSync(QRIS_PATH);
  cache = null;
  return true;
}

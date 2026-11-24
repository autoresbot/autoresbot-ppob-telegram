// Cache daftar produk + perhitungan harga jual
import { ppob } from './ppob.js';
import * as store from './db.js';
import { config } from './config.js';

const collator = new Intl.Collator('id');
let all = [];
let skuMap = new Map();
let brandMap = new Map(); // kategori -> Set(brand)
let cats = [];
export let updatedAt = 0;
/** Error terakhir saat memuat produk ({ code, message, at }), null bila terakhir berhasil */
export let lastError = null;

const listeners = new Set();
/** fn(err | null): dipanggil saat status berubah — gagal (kode baru) atau pulih */
export const onStatusChange = (fn) => listeners.add(fn);
const emit = (err) => listeners.forEach((fn) => Promise.resolve().then(() => fn(err)).catch(() => {}));

export async function refresh() {
  let data;
  try {
    data = await ppob.produk();
  } catch (e) {
    const changed = lastError?.code !== (e.code ?? 'UNKNOWN') || lastError?.message !== e.message;
    lastError = { code: e.code ?? 'UNKNOWN', message: e.message, at: Date.now() };
    if (changed) emit(lastError);
    throw e;
  }
  if (lastError) {
    lastError = null;
    emit(null);
  }
  const list = Array.isArray(data?.produk) ? data.produk : [];
  all = list;
  skuMap = new Map(list.map((p) => [p.sku, p]));
  brandMap = new Map();
  for (const p of list) {
    if (!brandMap.has(p.kategori)) brandMap.set(p.kategori, new Set());
    brandMap.get(p.kategori).add(p.brand);
  }
  cats = [...brandMap.keys()].sort(collator.compare);
  updatedAt = Date.now();
  return list.length;
}

/** Muat ulang tiap 15 menit; saat gagal dicoba lagi tiap 1 menit agar cepat pulih setelah diperbaiki. */
export function startAutoRefresh(intervalMs = 15 * 60 * 1000, retryMs = 60 * 1000) {
  if (!config.apiKey) {
    console.warn('[katalog] dilewati: AUTORESBOT_APIKEY belum diisi');
    return;
  }
  const run = async () => {
    let ok = false;
    try {
      console.log(`[katalog] ${await refresh()} produk dimuat`);
      ok = true;
    } catch (e) {
      console.error(`[katalog] gagal memuat produk: ${e.code ?? ''} ${e.message}`);
    }
    setTimeout(run, ok ? intervalMs : retryMs).unref();
  };
  run();
}

export const categories = () => cats;
export const brands = (cat) => [...(brandMap.get(cat) ?? [])].sort(collator.compare);
export const products = (cat, brand) =>
  all.filter((p) => p.kategori === cat && p.brand === brand).sort((a, b) => a.harga - b.harga);
export const bySku = (sku) => skuMap.get(sku);

export function getMarkup() {
  return {
    flat: Number(store.getSetting('markup_flat', config.markupFlat)),
    percent: Number(store.getSetting('markup_percent', config.markupPercent)),
  };
}

export function sellPrice(modal) {
  const { flat, percent } = getMarkup();
  const raw = Math.max(modal, modal + (modal * percent) / 100 + flat);
  return Math.ceil(raw / config.roundTo) * config.roundTo;
}

/** Jenis isian tujuan berdasarkan kategori/brand (lihat "Format tujuan" di dokumentasi). */
export function kindOf(p) {
  const k = `${p.kategori} ${p.brand}`.toLowerCase();
  if (/mobile\s*-?\s*legends?/.test(k)) return 'ml';
  if (/\bpln\b|token listrik/.test(k)) return 'pln';
  if (/pulsa|data|sms|telp|masa aktif|e-?money|e-?wallet|dana|ovo|gopay|shopee ?pay|linkaja/.test(k)) return 'phone';
  return 'other';
}

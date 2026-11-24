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

export async function refresh() {
  const data = await ppob.produk();
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

export function startAutoRefresh(intervalMs = 15 * 60 * 1000) {
  if (!config.apiKey) {
    console.warn('[katalog] dilewati: AUTORESBOT_APIKEY belum diisi');
    return;
  }
  const run = () =>
    refresh()
      .then((n) => console.log(`[katalog] ${n} produk dimuat`))
      .catch((e) => console.error(`[katalog] gagal memuat produk: ${e.code ?? ''} ${e.message}`));
  run();
  setInterval(run, intervalMs).unref();
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

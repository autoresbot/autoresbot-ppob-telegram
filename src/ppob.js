// Klien API PPOB Autoresbot — https://autoresbot.com/api/v1/ppob
import { config } from './config.js';

const BASE = 'https://autoresbot.com/api/v1/ppob';

// Error 5xx yang pasti berarti transaksi TIDAK dibuat (bukan hasil yang tidak pasti)
const DEFINITE_5XX = new Set(['CUT_OFF', 'API_DISABLED', 'SERVICE_CLOSED']);

export class PpobError extends Error {
  constructor(message, { code = 'NETWORK_ERROR', status = 0 } = {}) {
    super(message);
    this.name = 'PpobError';
    this.code = code;
    this.status = status;
  }

  /**
   * true = hasil tidak pasti (timeout, koneksi putus, 429, 5xx):
   * transaksi mungkin sudah dibuat, jadi harus dikirim ulang dengan ref_id yang sama / dicek,
   * BUKAN langsung di-refund.
   */
  get ambiguous() {
    if (this.status === 0 || this.status === 429 || this.code === 'INVALID_RESPONSE') return true;
    return this.status >= 500 && !DEFINITE_5XX.has(this.code);
  }
}

async function request(method, path, body, timeoutMs = 30_000) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new PpobError(`Gagal terhubung ke server PPOB: ${err.message}`);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new PpobError(`Respons server tidak valid (HTTP ${res.status})`, {
      code: 'INVALID_RESPONSE',
      status: res.status,
    });
  }

  if (!json?.success) {
    throw new PpobError(json?.error?.message || `HTTP ${res.status}`, {
      code: json?.error?.code || 'UNKNOWN',
      status: res.status,
    });
  }
  return json.data;
}

const qs = (params) => {
  const s = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  return s ? `?${s}` : '';
};

export const ppob = {
  saldo: () => request('GET', '/saldo'),
  produk: (filter = {}) => request('GET', '/produk' + qs(filter)),
  /** timeoutMs lebih pendek dipakai saat pelanggan menunggu (detail hanya pelengkap) */
  detailProduk: (sku, timeoutMs) => request('GET', `/produk/${encodeURIComponent(sku)}`, undefined, timeoutMs),
  /** body: { sku, tujuan, ref_id, zone?, max_harga? } — idempoten per ref_id */
  beli: (body) => request('POST', '/transaksi', body),
  status: (refId) => request('GET', `/transaksi/${encodeURIComponent(refId)}`),
  riwayat: (halaman = 1, per_halaman = 20) => request('GET', '/transaksi' + qs({ halaman, per_halaman })),
};

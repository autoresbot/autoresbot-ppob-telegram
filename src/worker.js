// Mengirim transaksi ke API & memantau status sampai final (tidak ada webhook → polling)
import * as store from './db.js';
import * as catalog from './catalog.js';
import { ppob, PpobError } from './ppob.js';
import { friendlyError, apiProblemHtml, ADMIN_ALERT_CODES } from './errors.js';
import { config, isAdmin } from './config.js';
import { esc, rp } from './format.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Selama jendela ini transaksi berstatus tidak pasti dikirim ulang (ref_id sama = aman, tidak dobel)
const RESUBMIT_WINDOW = 10 * 60 * 1000;
const TICK_MS = 5_000;
const CHECKS_PER_TICK = 5; // ±60 request/menit, di bawah batas 120/menit

export function createWorker(bot) {
  const busy = new Set();

  const send = (chatId, text, extra = {}) =>
    bot.telegram
      .sendMessage(chatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra })
      .catch((e) => console.error(`[notify] ${chatId}: ${e.message}`));

  const alertAdmins = (text) => Promise.all(config.adminIds.map((id) => send(id, text)));

  const detail = (t) =>
    `Produk: <b>${esc(t.produk)}</b>\n` +
    `Tujuan: <code>${esc(t.tujuan)}${t.zone ? ` (${esc(t.zone)})` : ''}</code>\n` +
    `Harga: ${rp(t.harga_jual)}\n` +
    `Ref: <code>${esc(t.ref_id)}</code>`;

  function notifyFinal(t) {
    if (!t) return;
    if (t.status === 'success') {
      send(t.user_id, `✅ <b>Transaksi berhasil</b>\n\n${detail(t)}${t.sn ? `\nSN / Token: <code>${esc(t.sn)}</code>` : ''}`);
    } else {
      send(
        t.user_id,
        `❌ <b>Transaksi gagal</b>\n\n${detail(t)}\nAlasan: ${esc(t.pesan || '-')}\n\n` +
          `Saldo ${rp(t.harga_jual)} sudah dikembalikan.`,
      );
    }
  }

  const nextDelay = (t, status) => {
    if (status === 'review') return 60_000;
    const age = Date.now() - (t.submitted_at ?? t.created_at);
    return age < 60_000 ? 5_000 : 30_000; // 5 dtk di menit pertama, lalu 30 dtk
  };

  /** Terapkan data transaksi dari server ke database lokal. */
  function applyRemote(ref, data, { announce = false } = {}) {
    const fields = { invoice: data.invoice ?? null, sn: data.sn ?? null, pesan: data.pesan ?? null };
    if (Number.isFinite(data.harga)) fields.harga_modal = data.harga;

    if (data.status === 'success' || data.status === 'refunded') {
      const t = store.finalizeTrx(ref, data.status, fields);
      notifyFinal(t);
      return t ?? store.getTrx(ref);
    }

    const before = store.getTrx(ref);
    const submittedAt = before.submitted_at ?? Date.now();
    // Status lain yang tidak dikenal tetap dianggap "processing" agar terus dipantau (tidak macet / tanpa refund)
    const status = data.status === 'review' ? 'review' : 'processing';
    const t = store.updateTrx(ref, {
      ...fields,
      status,
      submitted_at: submittedAt,
      next_check_at: Date.now() + nextDelay({ ...before, submitted_at: submittedAt }, data.status),
    });
    if (announce) {
      send(t.user_id, `⏳ <b>Pesanan sedang diproses</b>\n\n${detail(t)}\n\nNotifikasi dikirim otomatis saat selesai.`);
    }
    return t;
  }

  /** Transaksi pasti tidak dibuat di server → gagal + refund. */
  function rejectTrx(ref, err) {
    const t = store.finalizeTrx(ref, 'failed', { pesan: friendlyError(err) });
    notifyFinal(t);
    if (err.code === 'PRICE_CHANGED') catalog.refresh().catch(() => {});
    const refLine = `\nRef: <code>${esc(ref)}</code>`;
    if (ADMIN_ALERT_CODES.has(err.code)) {
      alertAdmins(apiProblemHtml(err, 'Transaksi pelanggan gagal karena masalah akun/API') + refLine);
    } else if (t && isAdmin(t.user_id)) {
      // Owner/admin yang membeli: tampilkan alasan asli dari server, bukan hanya pesan ramah
      send(t.user_id, apiProblemHtml(err, 'Detail error (khusus admin)') + refLine);
    }
    return t;
  }

  const payload = (t) => ({
    sku: t.sku,
    tujuan: t.tujuan,
    ref_id: t.ref_id,
    max_harga: t.harga_modal,
    ...(t.zone ? { zone: t.zone } : {}),
  });

  /** Kirim transaksi baru (dipanggil setelah saldo pelanggan dipotong). */
  async function submit(ref) {
    busy.add(ref);
    try {
      const t = store.getTrx(ref);
      for (let attempt = 1; ; attempt++) {
        try {
          return applyRemote(ref, await ppob.beli(payload(t)), { announce: true });
        } catch (err) {
          if (err instanceof PpobError && !err.ambiguous) return rejectTrx(ref, err);
          console.warn(`[submit] ${ref} percobaan ${attempt}: ${err.code ?? ''} ${err.message}`);
          if (attempt >= 3) {
            const u = store.updateTrx(ref, { status: 'unknown', next_check_at: Date.now() + 30_000 });
            send(
              t.user_id,
              `⏳ <b>Pesanan sedang diproses</b>\n\n${detail(t)}\n\nServer sedang lambat; status dikirim otomatis.`,
            );
            return u;
          }
          await sleep(attempt * 3_000);
        }
      }
    } finally {
      busy.delete(ref);
    }
  }

  /** Cek ulang satu transaksi yang belum final. */
  async function check(t) {
    const ref = t.ref_id;
    const uncertain = t.status === 'submitting' || t.status === 'unknown';
    const resubmit = uncertain && Date.now() - t.created_at < RESUBMIT_WINDOW;
    try {
      const data = resubmit ? await ppob.beli(payload(t)) : await ppob.status(ref);
      return applyRemote(ref, data);
    } catch (err) {
      const definite = err instanceof PpobError && !err.ambiguous;
      if (uncertain && definite && (resubmit || err.code === 'TRANSACTION_NOT_FOUND')) {
        return rejectTrx(ref, err);
      }
      console.warn(`[cek] ${ref}: ${err.code ?? ''} ${err.message}`);
      store.updateTrx(ref, { next_check_at: Date.now() + 30_000 });
    }
  }

  /**
   * Penyelesaian manual oleh admin: action = 'refund' | 'success'.
   * Selalu cek server dulu. Bila server sudah final → disinkronkan (bukan keputusan admin).
   * Bila server belum final / tidak bisa dicek → wajib force, karena transaksi masih bisa berubah.
   * Mengembalikan { trx, note } atau { error }.
   */
  async function resolveManual(ref, action, { force = false, sn = null, adminId } = {}) {
    const t = store.getTrx(ref);
    if (!t) return { error: 'Transaksi tidak ditemukan di database bot.' };
    if (store.FINAL.has(t.status)) return { error: `Transaksi sudah final (${t.status}).` };
    if (busy.has(ref)) return { error: 'Transaksi sedang dicek worker, ulangi beberapa detik lagi.' };

    busy.add(ref);
    try {
      let remote = null;
      let remoteErr = null;
      try {
        remote = await ppob.status(ref);
      } catch (e) {
        remoteErr = e;
      }

      if (remote?.status === 'success' || remote?.status === 'refunded') {
        return { trx: applyRemote(ref, remote), note: `Server sudah final (${remote.status}), data disinkronkan.` };
      }

      const notFound = remoteErr?.code === 'TRANSACTION_NOT_FOUND';
      const serverInfo = remote
        ? `status server: <b>${esc(remote.status)}</b>`
        : notFound
          ? 'transaksi <b>tidak ada</b> di server'
          : `server tidak bisa dicek (${esc(remoteErr?.code ?? '')} ${esc(remoteErr?.message ?? '')})`;

      // Refund tanpa paksa hanya bila server pasti tidak punya transaksi ini
      const allowed = force || (action === 'refund' && notFound);
      if (!allowed) {
        const cmd = action === 'refund' ? `/refund ${ref} paksa` : `/sukses ${ref} SN paksa`;
        return {
          error:
            `Ditolak: ${serverInfo}. Transaksi masih bisa berubah, jadi sebaiknya tunggu.\n` +
            `Bila Anda yakin, kirim: <code>${esc(cmd)}</code>`,
        };
      }

      const by = `oleh admin ${adminId ?? ''}`.trim();
      const r =
        action === 'refund'
          ? store.finalizeTrx(ref, 'failed', { pesan: `Dibatalkan ${by}` })
          : store.finalizeTrx(ref, 'success', { sn: sn || t.sn, pesan: `Diselesaikan manual ${by}` });
      notifyFinal(r);
      console.warn(`[manual] ${ref} → ${action} ${by} (${serverInfo.replace(/<[^>]+>/g, '')})`);
      return { trx: r ?? store.getTrx(ref), note: `Selesai (${serverInfo}).` };
    } finally {
      busy.delete(ref);
    }
  }

  let running = false;
  let timer = null;
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const t of store.dueTrx(CHECKS_PER_TICK)) {
        if (busy.has(t.ref_id)) continue;
        busy.add(t.ref_id);
        try {
          await check(t);
        } finally {
          busy.delete(t.ref_id);
        }
      }
    } catch (err) {
      console.error('[worker]', err);
    } finally {
      running = false;
    }
  }

  return {
    submit,
    resolveManual,
    alertAdmins,
    send,
    start() {
      if (!config.apiKey) {
        console.warn('[worker] dilewati: AUTORESBOT_APIKEY belum diisi');
        return;
      }
      timer = setInterval(tick, TICK_MS);
      tick();
    },
    stop() {
      clearInterval(timer);
    },
  };
}

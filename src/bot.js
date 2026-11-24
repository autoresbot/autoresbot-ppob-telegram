// Handler Telegram: menu pelanggan, alur beli, deposit, dan perintah admin
import crypto from 'node:crypto';
import { Markup, Input } from 'telegraf';
import { config, isAdmin, VERSION } from './config.js';
import { isReady, configComplete, setupReportHtml } from './setup.js';
import * as payment from './payment.js';
import * as store from './db.js';
import * as catalog from './catalog.js';
import { ppob } from './ppob.js';
import { parseTujuan, parseByIsian, normalizeIsian, isianHint, HINTS } from './validate.js';
import { createBackup } from './jobs.js';
import { apiProblemHtml } from './errors.js';
import { esc, rp, fmtDate, chunk, STATUS_LABEL } from './format.js';

const BTN = {
  beli: '🛒 Beli Produk',
  saldo: '💰 Saldo',
  deposit: '➕ Deposit',
  riwayat: '📜 Riwayat',
  bantuan: '❓ Bantuan',
};
const MAIN_MENU = Markup.keyboard([
  [BTN.beli, BTN.saldo],
  [BTN.deposit, BTN.riwayat],
  [BTN.bantuan],
]).resize();
const CANCEL_KB = Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'cancel')]]);
const PAGE_SIZE = 10;
const HTML = { parse_mode: 'HTML' };

/* ---------- sesi percakapan (di memori, kedaluwarsa 15 menit) ---------- */
const sessions = new Map();
const SESSION_TTL = 15 * 60 * 1000;
const getSession = (uid) => {
  const s = sessions.get(uid);
  if (s && Date.now() - s.at > SESSION_TTL) {
    sessions.delete(uid);
    return null;
  }
  return s ?? null;
};
const setSession = (uid, data) => sessions.set(uid, { ...data, at: Date.now() });

/* ---------- anti-spam: maksimal 20 pesan/tombol per 10 detik per pelanggan ---------- */
const RATE = { windowMs: 10_000, max: 20 };
const hits = new Map();
/** false = boleh; 'warn' = lewat batas (beri peringatan sekali); 'silent' = abaikan */
function rateLimited(uid) {
  const t = Date.now();
  let h = hits.get(uid);
  if (!h || t - h.start > RATE.windowMs) {
    h = { start: t, n: 0, warned: false };
    hits.set(uid, h);
  }
  if (++h.n <= RATE.max) return false;
  if (h.warned) return 'silent';
  h.warned = true;
  return 'warn';
}
// Bersihkan data kedaluwarsa agar memori tidak terus bertambah
setInterval(() => {
  const t = Date.now();
  for (const [k, h] of hits) if (t - h.start > RATE.windowMs) hits.delete(k);
  for (const [k, s] of sessions) if (t - s.at > SESSION_TTL) sessions.delete(k);
}, 60_000).unref();

/** cut_off dari API: { mulai: "23:45", selesai: "00:15" } (selesai bisa "null"), atau null */
const fmtCutOff = (co) => {
  const ok = (v) => v && v !== 'null';
  if (!co || typeof co !== 'object' || !ok(co.mulai)) return '';
  return ok(co.selesai) ? `${co.mulai}–${co.selesai}` : `mulai ${co.mulai}`;
};

const MUT_LABEL = { deposit: '➕ Deposit', purchase: '🛒 Beli', refund: '↩️ Refund', admin: '🛠 Koreksi admin' };

const makeRefId = (uid) =>
  `TG${uid}-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

/* ---------- status konfigurasi ---------- */

const NOT_READY = {
  transaksi: '⚙️ <b>Bot belum siap melayani transaksi.</b>\nKonfigurasi toko belum selesai. Silakan coba lagi nanti.',
  deposit: '⚙️ <b>Fitur deposit belum tersedia.</b>\nData pembayaran toko belum diatur. Silakan hubungi admin.',
};

/** Balas pesan "belum siap" (sebagai alert bila dari tombol). Admin juga melihat detail konfigurasi. */
async function replyNotReady(ctx, feature) {
  if (ctx.callbackQuery) await ctx.answerCbQuery('Konfigurasi belum selesai', { show_alert: true }).catch(() => {});
  const extra = isAdmin(ctx.from.id) ? `\n\n${setupReportHtml()}` : '';
  return ctx.reply(NOT_READY[feature] + extra, HTML);
}

/** Edit pesan bila dari tombol inline, selain itu kirim pesan baru. */
async function show(ctx, text, keyboard) {
  const extra = { ...HTML, link_preview_options: { is_disabled: true }, ...(keyboard ?? {}) };
  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, extra);
    } catch (e) {
      if (String(e.description || e.message).includes('message is not modified')) return;
    }
  }
  return ctx.reply(text, extra);
}

/* ---------- tampilan katalog ---------- */

function categoriesView(admin = false) {
  const cats = catalog.categories();
  if (!cats.length) {
    if (!admin) return { text: '⚠️ Daftar produk belum tersedia. Silakan coba lagi beberapa saat lagi.' };
    // Owner/admin: tampilkan penyebab & cara memperbaiki
    const text = catalog.lastError
      ? apiProblemHtml(catalog.lastError) + '\n\n<i>Bot mencoba lagi otomatis tiap 1 menit.</i>'
      : '⏳ Daftar produk sedang dimuat. Tunggu sebentar lalu tekan Coba lagi.';
    return { text, kb: Markup.inlineKeyboard([[Markup.button.callback('🔄 Coba lagi', 'retry_catalog')]]) };
  }
  const buttons = cats.map((c, i) => Markup.button.callback(c, `cat:${i}`));
  return { text: '🛒 <b>Pilih kategori</b>', kb: Markup.inlineKeyboard(chunk(buttons, 2)) };
}

function brandsView(ci, admin = false) {
  const cat = catalog.categories()[ci];
  if (!cat) return categoriesView(admin);
  const buttons = catalog.brands(cat).map((b, bi) => Markup.button.callback(b, `br:${ci}:${bi}:0`));
  return {
    text: `🛒 <b>${esc(cat)}</b>\nPilih brand / operator:`,
    kb: Markup.inlineKeyboard([...chunk(buttons, 2), [Markup.button.callback('⬅️ Kembali', 'buy')]]),
  };
}

function productsView(ci, bi, page) {
  const cat = catalog.categories()[ci];
  const brand = cat && catalog.brands(cat)[bi];
  if (!brand) return categoriesView();
  const items = catalog.products(cat, brand);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  page = Math.min(Math.max(page, 0), pages - 1);

  const rows = items
    .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    .map((p) => [
      Markup.button.callback(`${p.tersedia ? '' : '⛔ '}${p.nama} • ${rp(catalog.sellPrice(p.harga))}`, `p:${p.sku}`),
    ]);
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('◀️', `br:${ci}:${bi}:${page - 1}`));
  if (page < pages - 1) nav.push(Markup.button.callback('▶️', `br:${ci}:${bi}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('⬅️ Kembali', `cat:${ci}`)]);

  return {
    text: `🛒 <b>${esc(cat)} › ${esc(brand)}</b>\nHalaman ${page + 1}/${pages} • ⛔ = sedang gangguan/cut off`,
    kb: Markup.inlineKeyboard(rows),
  };
}

function confirmView(s, user, notice = '') {
  return {
    text:
      `${notice}🧾 <b>Konfirmasi Pesanan</b>\n\n` +
      `Produk: <b>${esc(s.produk)}</b>\n` +
      `Tujuan: <code>${esc(s.tujuan)}${s.zone ? ` (${esc(s.zone)})` : ''}</code>\n` +
      `Harga: <b>${rp(s.hargaJual)}</b>\n\n` +
      `Saldo Anda: ${rp(user.saldo)}` +
      (user.saldo < s.hargaJual ? `\n⚠️ Saldo kurang ${rp(s.hargaJual - user.saldo)}. Silakan deposit dulu.` : ''),
    kb: Markup.inlineKeyboard([
      [Markup.button.callback('✅ Bayar', 'pay'), Markup.button.callback('❌ Batal', 'cancel')],
    ]),
  };
}

/* ---------- registrasi handler ---------- */

export function registerHandlers(bot, worker) {
  // Hanya chat pribadi; daftarkan / perbarui user; tolak user yang diblokir
  bot.use(async (ctx, next) => {
    if (!ctx.from || (ctx.chat && ctx.chat.type !== 'private')) return;
    if (!isAdmin(ctx.from.id)) {
      const limited = rateLimited(ctx.from.id);
      if (limited === 'warn') {
        const msg = '⏳ Terlalu cepat. Tunggu beberapa detik lalu coba lagi.';
        return ctx.callbackQuery ? ctx.answerCbQuery(msg, { show_alert: true }).catch(() => {}) : ctx.reply(msg);
      }
      if (limited) return ctx.callbackQuery ? ctx.answerCbQuery().catch(() => {}) : undefined;
    }
    store.upsertUser(ctx.from);
    const user = store.getUser(ctx.from.id);
    if (user.banned && !isAdmin(ctx.from.id)) {
      if (ctx.callbackQuery) return ctx.answerCbQuery('Akun Anda diblokir.', { show_alert: true });
      return ctx.reply('⛔ Akun Anda diblokir. Hubungi admin.');
    }
    ctx.state.user = user;
    return next();
  });

  const adminOnly = (handler) => (ctx, next) => (isAdmin(ctx.from.id) ? handler(ctx, next) : next());

  /* ----- menu utama ----- */

  bot.start((ctx) => {
    sessions.delete(ctx.from.id);
    return ctx.reply(
      `👋 Selamat datang di <b>${esc(config.storeName)}</b>!\n\n` +
        `Beli pulsa, paket data, top up game, e-money & token PLN — proses otomatis 24 jam.\n\n` +
        `Saldo Anda: <b>${rp(ctx.state.user.saldo)}</b>` +
        (configComplete()
          ? ''
          : isAdmin(ctx.from.id)
            ? `\n\n${setupReportHtml()}`
            : '\n\n⚙️ <i>Toko sedang dalam persiapan, beberapa fitur belum tersedia.</i>'),
      { ...HTML, ...MAIN_MENU },
    );
  });

  const openBuy = (ctx) => {
    sessions.delete(ctx.from.id);
    if (!isReady.transaksi()) return replyNotReady(ctx, 'transaksi');
    const v = categoriesView(isAdmin(ctx.from.id));
    return show(ctx, v.text, v.kb);
  };
  const openSaldo = (ctx) => {
    sessions.delete(ctx.from.id);
    const u = store.getUser(ctx.from.id);
    return ctx.reply(`💰 Saldo Anda: <b>${rp(u.saldo)}</b>\nID: <code>${u.id}</code>`, HTML);
  };
  const openDeposit = (ctx) => {
    if (!isReady.deposit()) {
      sessions.delete(ctx.from.id);
      return replyNotReady(ctx, 'deposit');
    }
    if (store.countPendingDeposits(ctx.from.id) >= config.maxPendingDeposit) {
      sessions.delete(ctx.from.id);
      return ctx.reply(
        `⚠️ Anda masih punya ${config.maxPendingDeposit} deposit yang menunggu konfirmasi.\n` +
          `Kirim foto bukti transfernya di chat ini, atau tunggu konfirmasi admin.`,
      );
    }
    setSession(ctx.from.id, { step: 'deposit_amount' });
    return ctx.reply(
      `➕ <b>Deposit Saldo</b>\n\nKetik nominal deposit (min ${rp(config.minDeposit)}, maks ${rp(config.maxDeposit)}).\nContoh: <code>50000</code>`,
      { ...HTML, ...CANCEL_KB },
    );
  };
  const openRiwayat = (ctx) => {
    sessions.delete(ctx.from.id);
    const rows = store.userTrx(ctx.from.id, 10);
    if (!rows.length) return ctx.reply('📜 Belum ada transaksi.');
    const lines = rows.map(
      (t) =>
        `${STATUS_LABEL[t.status] ?? t.status} • ${fmtDate(t.created_at)}\n` +
        `<b>${esc(t.produk)}</b> → <code>${esc(t.tujuan)}</code> • ${rp(t.harga_jual)}` +
        (t.sn ? `\nSN: <code>${esc(t.sn)}</code>` : ''),
    );
    return ctx.reply(`📜 <b>10 transaksi terakhir</b>\n\n${lines.join('\n\n')}`, HTML);
  };
  const mutasiText = (u, rows, forAdmin) =>
    rows.length
      ? `📒 <b>Mutasi saldo${forAdmin ? ` ${esc(u.name)} (<code>${u.id}</code>)` : ''}</b>\n` +
        `Saldo sekarang: <b>${rp(u.saldo)}</b>\n\n` +
        rows
          .map(
            (m) =>
              `${fmtDate(m.created_at)} • ${MUT_LABEL[m.type] ?? esc(m.type)}\n` +
              `<b>${m.amount > 0 ? '+' : '−'}${rp(Math.abs(m.amount))}</b> → saldo ${rp(m.saldo_after)}` +
              (m.note && (forAdmin || m.type !== 'admin') ? `\n<i>${esc(m.note)}</i>` : ''),
          )
          .join('\n\n')
      : '📒 Belum ada mutasi saldo.';

  bot.command('mutasi', (ctx) => {
    sessions.delete(ctx.from.id);
    // Admin: /mutasi <user_id> untuk melihat mutasi pelanggan lain
    const forAdmin = isAdmin(ctx.from.id) && ctx.args[0] !== undefined;
    const u = store.getUser(forAdmin ? Number(ctx.args[0]) : ctx.from.id);
    if (!u) return ctx.reply('User tidak ditemukan.');
    return ctx.reply(mutasiText(u, store.userMutations(u.id, 15), forAdmin), HTML);
  });

  const openBantuan = (ctx) =>
    ctx.reply(
      `❓ <b>Bantuan</b>\n\n` +
        `1. Isi saldo lewat <b>${BTN.deposit}</b>, transfer sesuai nominal, kirim bukti.\n` +
        `2. Pilih <b>${BTN.beli}</b> → kategori → brand → produk.\n` +
        `3. Masukkan nomor / ID tujuan, cek konfirmasi, tekan <b>Bayar</b>.\n` +
        `4. Status & SN dikirim otomatis. Bila gagal, saldo dikembalikan otomatis.\n\n` +
        `Lupa kirim bukti transfer? Kirim saja fotonya kapan pun di chat ini.\n\n` +
        `Perintah: /beli /saldo /deposit /riwayat /mutasi /batal`,
      HTML,
    );

  bot.hears(BTN.beli, openBuy);
  bot.command('beli', openBuy);
  bot.hears(BTN.saldo, openSaldo);
  bot.command('saldo', openSaldo);
  bot.hears(BTN.deposit, openDeposit);
  bot.command('deposit', openDeposit);
  bot.hears(BTN.riwayat, openRiwayat);
  bot.command('riwayat', openRiwayat);
  bot.hears(BTN.bantuan, openBantuan);
  bot.command(['bantuan', 'help'], openBantuan);
  bot.command('batal', (ctx) => {
    sessions.delete(ctx.from.id);
    return ctx.reply('Dibatalkan.', MAIN_MENU);
  });

  /* ----- navigasi katalog ----- */

  bot.action('buy', async (ctx) => {
    await ctx.answerCbQuery();
    return openBuy(ctx);
  });

  bot.action(/^cat:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const v = brandsView(Number(ctx.match[1]), isAdmin(ctx.from.id));
    return show(ctx, v.text, v.kb);
  });

  // Admin: muat ulang produk sekarang (mis. setelah menambah IP ke whitelist)
  bot.action('retry_catalog', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Khusus admin', { show_alert: true });
    await ctx.answerCbQuery('Memuat ulang produk…');
    try {
      await catalog.refresh();
    } catch {
      // error tersimpan di catalog.lastError dan ditampilkan di bawah
    }
    const v = categoriesView(true);
    return show(ctx, v.text, v.kb);
  });

  bot.action(/^br:(\d+):(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const [, ci, bi, page] = ctx.match.map(Number);
    const v = productsView(ci, bi, page);
    return show(ctx, v.text, v.kb);
  });

  bot.action(/^p:(.+)$/, async (ctx) => {
    if (!isReady.transaksi()) return replyNotReady(ctx, 'transaksi');
    const p = catalog.bySku(ctx.match[1]);
    if (!p) return ctx.answerCbQuery('Produk tidak ditemukan, buka ulang menu.', { show_alert: true });
    if (!p.tersedia) {
      const co = fmtCutOff(p.cut_off);
      return ctx.answerCbQuery(`Produk sedang cut off / gangguan${co ? ` (cut off ${co} WIB)` : ''}.`, {
        show_alert: true,
      });
    }
    await ctx.answerCbQuery();

    let info = null;
    try {
      info = await ppob.detailProduk(p.sku, 8_000);
    } catch {
      // detail opsional; lanjut dengan validasi cadangan
    }
    // Utamakan aturan isian resmi dari API (label + pola); bila tidak ada, tebak dari kategori/brand
    const fields = normalizeIsian(info?.isian);
    const kind = catalog.kindOf(p);
    const needZone = fields ? fields.length > 1 : kind === 'ml';
    setSession(ctx.from.id, { step: 'tujuan', sku: p.sku, kind, needZone, fields });

    const hint = fields ? isianHint(fields) : needZone ? HINTS.zone : HINTS[kind];
    return ctx.reply(
      `📦 <b>${esc(p.nama)}</b>\nHarga: <b>${rp(catalog.sellPrice(p.harga))}</b>` +
        (info?.deskripsi ? `\n<i>${esc(info.deskripsi)}</i>` : '') +
        `\n\n${hint}`,
      { ...HTML, ...CANCEL_KB },
    );
  });

  bot.action('cancel', async (ctx) => {
    sessions.delete(ctx.from.id);
    await ctx.answerCbQuery('Dibatalkan');
    return show(ctx, 'Dibatalkan.');
  });

  /* ----- bayar ----- */

  bot.action('pay', async (ctx) => {
    const uid = ctx.from.id;
    if (!isReady.transaksi()) return replyNotReady(ctx, 'transaksi');
    const s = getSession(uid);
    if (!s || s.step !== 'confirm') {
      return ctx.answerCbQuery('Sesi kedaluwarsa, silakan ulangi pembelian.', { show_alert: true });
    }
    sessions.delete(uid); // cegah tombol ditekan dua kali

    const p = catalog.bySku(s.sku);
    if (!p || !p.tersedia) {
      await ctx.answerCbQuery();
      return show(ctx, '⛔ Produk sedang tidak tersedia. Silakan pilih produk lain.');
    }

    // Harga berubah sejak konfirmasi → minta konfirmasi ulang
    const hargaJual = catalog.sellPrice(p.harga);
    if (hargaJual !== s.hargaJual) {
      const next = { ...s, hargaJual, hargaModal: p.harga };
      setSession(uid, next);
      await ctx.answerCbQuery('Harga berubah');
      const v = confirmView(next, store.getUser(uid), '⚠️ <b>Harga berubah</b>, mohon konfirmasi ulang.\n\n');
      return show(ctx, v.text, v.kb);
    }

    const refId = makeRefId(uid);
    try {
      store.createPurchase({
        refId,
        userId: uid,
        sku: p.sku,
        produk: p.nama,
        tujuan: s.tujuan,
        zone: s.zone,
        hargaJual,
        hargaModal: s.hargaModal,
      });
    } catch (e) {
      if (e instanceof store.InsufficientBalance) {
        await ctx.answerCbQuery('Saldo tidak cukup', { show_alert: true });
        return show(ctx, `⚠️ Saldo tidak cukup untuk ${rp(hargaJual)}. Silakan deposit dulu lewat ${BTN.deposit}.`);
      }
      throw e;
    }

    await ctx.answerCbQuery('Pesanan dikirim');
    await show(ctx, `⏳ Mengirim pesanan <b>${esc(p.nama)}</b> ke <code>${esc(s.tujuan)}</code>…`);
    // Jalan di latar belakang; notifikasi status dikirim oleh worker
    worker.submit(refId).catch((e) => console.error('[submit]', refId, e));
  });

  /* ----- deposit: konfirmasi admin ----- */

  const depositKb = (id) =>
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Terima', `dep:ok:${id}`), Markup.button.callback('❌ Tolak', `dep:no:${id}`)],
    ]);
  const depositCaption = (dep, user) =>
    `💳 <b>Deposit #${dep.id}</b>\n` +
    `User: ${esc(user?.name || '-')} ${user?.username ? '@' + esc(user.username) : ''} (<code>${dep.user_id}</code>)\n` +
    `Nominal transfer: <b>${rp(dep.amount)}</b>\n` +
    `Waktu: ${fmtDate(dep.created_at)}`;

  bot.action(/^dep:(ok|no):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Khusus admin', { show_alert: true });
    const approve = ctx.match[1] === 'ok';
    const res = store.processDeposit(Number(ctx.match[2]), ctx.from.id, approve);
    if (!res) return ctx.answerCbQuery('Deposit sudah diproses sebelumnya.', { show_alert: true });

    await ctx.answerCbQuery(approve ? 'Deposit diterima' : 'Deposit ditolak');
    const note = approve ? `\n\n✅ Diterima oleh ${esc(ctx.from.first_name)}` : `\n\n❌ Ditolak oleh ${esc(ctx.from.first_name)}`;
    const text = depositCaption(res.dep, store.getUser(res.dep.user_id)) + note;
    const edit = ctx.callbackQuery.message?.photo ? ctx.editMessageCaption(text, HTML) : ctx.editMessageText(text, HTML);
    await edit.catch(() => {});

    worker.send(
      res.dep.user_id,
      approve
        ? `✅ Deposit #${res.dep.id} sebesar <b>${rp(res.dep.amount)}</b> berhasil.\nSaldo sekarang: <b>${rp(res.saldo)}</b>`
        : `❌ Deposit #${res.dep.id} ditolak. Hubungi admin bila Anda sudah transfer.`,
    );
  });

  /* ----- perintah admin ----- */

  bot.command(
    'admin',
    adminOnly((ctx) =>
      ctx.reply(
        `🛠 <b>Perintah Admin</b> • v${VERSION}\n\n` +
          `/versi — versi bot\n` +
          `/config — cek kelengkapan konfigurasi\n` +
          `/setqris — ganti gambar QRIS • /hapusqris\n` +
          `/setpayment &lt;teks&gt; — ganti teks rekening / e-wallet\n` +
          `/payment — pratinjau instruksi deposit\n` +
          `/stat — ringkasan hari ini\n` +
          `/saldopusat — saldo akun Autoresbot\n` +
          `/addsaldo &lt;user_id&gt; &lt;jumlah&gt; — tambah/kurangi saldo (minus untuk kurangi)\n` +
          `/user &lt;user_id&gt; — info pelanggan\n` +
          `/markup [flat] [persen] — lihat/ubah keuntungan\n` +
          `/laporan [hari|minggu|bulan|semua] — rekap omzet & laba\n` +
          `/mutasi &lt;user_id&gt; — mutasi saldo pelanggan\n` +
          `/deposits — deposit menunggu konfirmasi\n` +
          `/pending — transaksi yang belum selesai\n` +
          `/cektrx &lt;ref_id&gt; — status transaksi\n` +
          `/refund &lt;ref_id&gt; [paksa] — batalkan & kembalikan saldo\n` +
          `/sukses &lt;ref_id&gt; [SN] [paksa] — tandai sukses manual\n` +
          `/refresh — muat ulang daftar produk\n` +
          `/backup — kirim file backup database\n` +
          `/ban &lt;user_id&gt; • /unban &lt;user_id&gt;\n` +
          `/bc &lt;pesan&gt; — broadcast ke semua pelanggan`,
        HTML,
      ),
    ),
  );

  bot.command(
    'versi',
    adminOnly((ctx) =>
      ctx.reply(
        `🤖 <b>${esc(config.storeName)}</b>\nVersi bot: <b>v${VERSION}</b>\nNode.js: ${process.version}\n` +
          `Berjalan sejak: ${fmtDate(Date.now() - process.uptime() * 1000)} WIB`,
        HTML,
      ),
    ),
  );

  bot.command(
    'config',
    adminOnly((ctx) => ctx.reply(setupReportHtml(), HTML)),
  );

  /* ----- data pembayaran deposit ----- */

  bot.command(
    'setqris',
    adminOnly((ctx) => {
      setSession(ctx.from.id, { step: 'set_qris' });
      return ctx.reply(
        '📷 Kirim <b>gambar QRIS</b> toko Anda sekarang.\n' +
          'Tips: kirim sebagai <i>File</i> (tanpa kompresi) agar QR tetap tajam.\n\n' +
          `Gambar disimpan di <code>${esc(payment.QRIS_PATH)}</code>.`,
        { ...HTML, ...CANCEL_KB },
      );
    }),
  );

  bot.command(
    'hapusqris',
    adminOnly((ctx) =>
      ctx.reply(payment.deleteQris() ? '🗑 Gambar QRIS dihapus.' : 'Belum ada gambar QRIS.'),
    ),
  );

  bot.command(
    'setpayment',
    adminOnly((ctx) => {
      const text = ctx.message.text.replace(/^\/setpayment(@\w+)?\s*/i, '').trim();
      if (!text) {
        return ctx.reply(
          'Format (boleh beberapa baris):\n<code>/setpayment Transfer ke:\nBCA 1234567890 a.n. Toko\nDANA 0812xxxx a.n. Toko</code>\n\n' +
            '<code>/setpayment -</code> untuk kembali memakai DEPOSIT_INFO di .env',
          HTML,
        );
      }
      payment.setPaymentText(text === '-' ? '' : text);
      return ctx.reply('✅ Teks pembayaran diperbarui. Cek dengan /payment');
    }),
  );

  bot.command(
    'payment',
    adminOnly((ctx) => {
      if (!payment.hasPayment()) return ctx.reply(setupReportHtml(), HTML);
      return sendPaymentInstructions(ctx, ctx.chat.id, null, config.minDeposit + 123);
    }),
  );

  // Perintah admin yang memanggil API butuh API key
  const needApi = (handler) =>
    adminOnly((ctx, next) => (isReady.transaksi() ? handler(ctx, next) : ctx.reply(setupReportHtml(), HTML)));

  bot.command(
    'stat',
    adminOnly((ctx) => {
      const s = store.stats();
      const m = catalog.getMarkup();
      return ctx.reply(
        `📊 <b>Statistik</b>\n\n` +
          `Pelanggan: ${s.users.n} • total saldo pelanggan: ${rp(s.users.saldo)}\n` +
          `Transaksi sukses hari ini: ${s.today.n}\nOmzet: ${rp(s.today.omzet)} • Laba: ${rp(s.today.laba)}\n` +
          `Transaksi berjalan: ${s.pending}\n` +
          `Markup: ${rp(m.flat)} + ${m.percent}%\n` +
          `Versi bot: v${VERSION}\n` +
          `Produk: ${catalog.categories().length} kategori, diperbarui ${catalog.updatedAt ? fmtDate(catalog.updatedAt) : '-'}`,
        HTML,
      );
    }),
  );

  bot.command(
    'saldopusat',
    needApi(async (ctx) => {
      try {
        const d = await ppob.saldo();
        return ctx.reply(`🏦 Saldo Autoresbot: <b>${rp(d.saldo)}</b>`, HTML);
      } catch (e) {
        return ctx.reply(apiProblemHtml(e, 'Gagal mengambil saldo Autoresbot'), HTML);
      }
    }),
  );

  bot.command(
    'addsaldo',
    adminOnly((ctx) => {
      const [id, amt] = ctx.args;
      const userId = Number(id);
      const amount = Number(amt);
      if (!Number.isInteger(userId) || !Number.isInteger(amount) || amount === 0) {
        return ctx.reply('Format: /addsaldo <user_id> <jumlah>');
      }
      if (!store.getUser(userId)) return ctx.reply('User belum pernah memakai bot.');
      try {
        const saldo = store.adjustBalance(userId, amount, 'admin', null, `oleh admin ${ctx.from.id}`);
        worker.send(userId, `💰 Saldo Anda ${amount > 0 ? 'bertambah' : 'berkurang'} ${rp(Math.abs(amount))}.\nSaldo sekarang: <b>${rp(saldo)}</b>`);
        return ctx.reply(`OK. Saldo ${userId} sekarang ${rp(saldo)}`);
      } catch (e) {
        if (e instanceof store.InsufficientBalance) return ctx.reply('Saldo user tidak cukup untuk dikurangi.');
        throw e;
      }
    }),
  );

  bot.command(
    'user',
    adminOnly((ctx) => {
      const u = store.getUser(Number(ctx.args[0]));
      if (!u) return ctx.reply('User tidak ditemukan.');
      const trx = store.userTrx(u.id, 5);
      return ctx.reply(
        `👤 <b>${esc(u.name)}</b> ${u.username ? '@' + esc(u.username) : ''}\nID: <code>${u.id}</code>\n` +
          `Saldo: ${rp(u.saldo)}\nStatus: ${u.banned ? 'diblokir' : 'aktif'}\nDaftar: ${fmtDate(u.created_at)}\n\n` +
          (trx.map((t) => `${STATUS_LABEL[t.status]} ${esc(t.produk)} → ${esc(t.tujuan)}`).join('\n') || 'Belum ada transaksi'),
        HTML,
      );
    }),
  );

  bot.command(
    'markup',
    adminOnly((ctx) => {
      const [flat, percent] = ctx.args.map(Number);
      if (ctx.args.length) {
        if (!Number.isFinite(flat) || flat < 0 || (ctx.args[1] !== undefined && (!Number.isFinite(percent) || percent < 0))) {
          return ctx.reply('Format: /markup <flat> [persen]\nContoh: /markup 500 2');
        }
        store.setSetting('markup_flat', flat);
        if (ctx.args[1] !== undefined) store.setSetting('markup_percent', percent);
      }
      const m = catalog.getMarkup();
      return ctx.reply(`Markup: ${rp(m.flat)} + ${m.percent}%\nContoh modal Rp10.000 → jual ${rp(catalog.sellPrice(10000))}`);
    }),
  );

  bot.command(
    'deposits',
    adminOnly(async (ctx) => {
      const list = store.pendingDeposits();
      if (!list.length) return ctx.reply('Tidak ada deposit menunggu.');
      for (const d of list.slice(0, 10)) {
        await ctx.reply(depositCaption(d, store.getUser(d.user_id)), { ...HTML, ...depositKb(d.id) });
      }
    }),
  );

  bot.command(
    'cektrx',
    needApi(async (ctx) => {
      const ref = ctx.args[0];
      if (!ref) return ctx.reply('Format: /cektrx <ref_id>');
      const local = store.getTrx(ref);
      let remote;
      try {
        remote = await ppob.status(ref);
      } catch (e) {
        remote = { error: `${e.code} ${e.message}` };
      }
      return ctx.reply(
        `<b>Lokal</b>\n<pre>${esc(JSON.stringify(local ?? null, null, 1))}</pre>\n` +
          `<b>Server</b>\n<pre>${esc(JSON.stringify(remote, null, 1))}</pre>`,
        HTML,
      );
    }),
  );

  bot.command(
    'refresh',
    needApi(async (ctx) => {
      try {
        const n = await catalog.refresh();
        return ctx.reply(`✅ ${n} produk dimuat.`);
      } catch (e) {
        return ctx.reply(apiProblemHtml(e), HTML);
      }
    }),
  );

  bot.command(
    'pending',
    adminOnly((ctx) => {
      const rows = store.pendingTrx(15);
      if (!rows.length) return ctx.reply('✅ Tidak ada transaksi yang sedang berjalan.');
      const lines = rows.map(
        (t) =>
          `${STATUS_LABEL[t.status] ?? ''} <code>${esc(t.status)}</code> • ${Math.round((Date.now() - t.created_at) / 60_000)} mnt\n` +
          `${esc(t.produk)} → <code>${esc(t.tujuan)}</code> • ${rp(t.harga_jual)}\n` +
          `<code>${esc(t.ref_id)}</code>`,
      );
      return ctx.reply(
        `⏳ <b>Transaksi berjalan (${rows.length}${rows.length === 15 ? '+' : ''})</b>\n\n${lines.join('\n\n')}\n\n` +
          `Cek: /cektrx &lt;ref&gt; • Manual: /refund &lt;ref&gt; atau /sukses &lt;ref&gt; [SN]`,
        HTML,
      );
    }),
  );

  // /refund <ref> [paksa]  •  /sukses <ref> [SN] [paksa]
  const manualCmd = (action) =>
    needApi(async (ctx) => {
      const args = [...ctx.args];
      const force = args.at(-1)?.toLowerCase() === 'paksa';
      if (force) args.pop();
      const [ref, ...rest] = args;
      if (!ref) {
        return ctx.reply(
          action === 'refund'
            ? 'Format: <code>/refund &lt;ref_id&gt; [paksa]</code>'
            : 'Format: <code>/sukses &lt;ref_id&gt; [SN] [paksa]</code>',
          HTML,
        );
      }
      await ctx.reply('🔎 Mengecek status di server…');
      const res = await worker.resolveManual(ref, action, {
        force,
        sn: action === 'success' ? rest.join(' ') || null : null,
        adminId: ctx.from.id,
      });
      if (res.error) return ctx.reply(`⚠️ ${res.error}`, HTML);
      const t = res.trx;
      return ctx.reply(
        `✅ ${res.note}\nStatus akhir: ${STATUS_LABEL[t.status] ?? esc(t.status)}\nRef: <code>${esc(t.ref_id)}</code>` +
          (t.status === 'success' ? (t.sn ? `\nSN: <code>${esc(t.sn)}</code>` : '') : `\nSaldo ${rp(t.harga_jual)} dikembalikan ke pelanggan.`) +
          '\nPelanggan sudah diberi notifikasi.',
        HTML,
      );
    });
  bot.command('refund', manualCmd('refund'));
  bot.command('sukses', manualCmd('success'));

  /* ----- laporan: hari ini / minggu ini / bulan ini / semua / N hari ----- */

  const LAP_ALIAS = {
    hari: 'hari', harian: 'hari', hariini: 'hari', today: 'hari',
    minggu: 'minggu', mingguan: 'minggu', mingguini: 'minggu', week: 'minggu',
    bulan: 'bulan', bulanan: 'bulan', bulanini: 'bulan', month: 'bulan',
    semua: 'semua', all: 'semua', total: 'semua',
  };
  const LAP_BUTTONS = [
    ['hari', 'Hari ini'],
    ['minggu', 'Minggu ini'],
    ['bulan', 'Bulan ini'],
    ['semua', 'Semua'],
  ];
  const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const fmtTgl = (ms) =>
    new Date(ms).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' });

  /** period: 'hari' | 'minggu' | 'bulan' | 'semua' | angka hari (1–365). Mengembalikan null bila tidak valid. */
  function laporanView(period) {
    let since;
    let title;
    let group = 'day';
    let perPeriod = true;
    if (period === 'hari') {
      [since, title, perPeriod] = [store.startOfDayWib(), 'Hari ini', false];
    } else if (period === 'minggu') {
      [since, title] = [store.startOfWeekWib(), 'Minggu ini'];
    } else if (period === 'bulan') {
      [since, title] = [store.startOfMonthWib(), 'Bulan ini'];
    } else if (period === 'semua') {
      [since, title, group] = [0, 'Semua waktu', 'month'];
    } else {
      const n = Number(period);
      if (!Number.isInteger(n) || n < 1 || n > 365) return null;
      [since, title] = [store.startOfDayWib(n - 1), `${n} hari terakhir`];
      if (n > 62) group = 'month';
    }

    const r = store.report(since, { group });
    const rows = r.days.slice(-31); // batas panjang pesan Telegram
    const label = (k) => (group === 'month' ? `${BULAN[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}` : `${k.slice(8, 10)}/${k.slice(5, 7)}`);
    const range =
      period === 'semua'
        ? r.first
          ? `sejak transaksi pertama ${fmtTgl(r.first)}`
          : 'belum ada transaksi'
        : period === 'hari'
          ? fmtTgl(since)
          : `${fmtTgl(since)} – hari ini`;
    const margin = r.total.omzet
      ? ` (${((r.total.laba / r.total.omzet) * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 })}%)`
      : '';
    const avg = r.total.n ? `\nRata-rata per transaksi: ${rp(Math.round(r.total.omzet / r.total.n))}` : '';

    const text =
      `📈 <b>Laporan — ${title}</b>\n<i>${range}</i>\n\n` +
      `Transaksi sukses: <b>${r.total.n}</b> • gagal/refund: ${r.gagal}\n` +
      `Omzet: <b>${rp(r.total.omzet)}</b>\nLaba: <b>${rp(r.total.laba)}</b>${margin}${avg}\n` +
      `Deposit diterima: ${r.deposit.n}× • ${rp(r.deposit.total)}\n` +
      `Pelanggan baru: ${r.userBaru}\n` +
      (perPeriod && rows.length
        ? `\n<b>Per ${group === 'month' ? 'bulan' : 'hari'}</b>${r.days.length > rows.length ? ' (31 terakhir)' : ''}\n` +
          rows.map((d) => `${label(d.hari)}: ${d.n} trx • ${rp(d.omzet)} • laba ${rp(d.laba)}`).join('\n') +
          '\n'
        : '') +
      (r.top.length
        ? `\n<b>Produk terlaris</b>\n` +
          r.top.map((p, i) => `${i + 1}. ${esc(p.produk)} — ${p.n}× • laba ${rp(p.laba)}`).join('\n') +
          '\n'
        : '') +
      `\n<i>Diperbarui ${fmtDate(Date.now())} WIB</i>`;

    const kb = Markup.inlineKeyboard([
      LAP_BUTTONS.slice(0, 2).map(([k, t]) => Markup.button.callback(k === period ? `• ${t} •` : t, `lap:${k}`)),
      LAP_BUTTONS.slice(2).map(([k, t]) => Markup.button.callback(k === period ? `• ${t} •` : t, `lap:${k}`)),
      [Markup.button.callback('🔄 Perbarui', `lap:${period}`)],
    ]);
    return { text, kb };
  }

  bot.command(
    'laporan',
    adminOnly((ctx) => {
      const arg = (ctx.args[0] ?? 'hari').toLowerCase();
      const v = laporanView(LAP_ALIAS[arg] ?? arg);
      if (!v) {
        return ctx.reply(
          'Format: <code>/laporan [hari | minggu | bulan | semua | jumlah hari]</code>\n' +
            'Contoh: <code>/laporan minggu</code>, <code>/laporan 30</code>',
          HTML,
        );
      }
      return ctx.reply(v.text, { ...HTML, ...v.kb });
    }),
  );

  bot.action(/^lap:(\w+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Khusus admin', { show_alert: true });
    const v = laporanView(ctx.match[1]);
    if (!v) return ctx.answerCbQuery('Periode tidak valid');
    await ctx.answerCbQuery();
    return show(ctx, v.text, v.kb);
  });

  bot.command(
    'backup',
    adminOnly(async (ctx) => {
      let file;
      try {
        file = createBackup();
      } catch (e) {
        return ctx.reply(`Gagal membuat backup: ${e.message}`);
      }
      return ctx.replyWithDocument(Input.fromLocalFile(file), {
        caption: '🗄 Backup database.\n⚠️ Rahasia: berisi data & saldo pelanggan. Jangan diteruskan ke orang lain.',
      });
    }),
  );

  const banCmd = (banned) =>
    adminOnly((ctx) => {
      const ok = store.setBanned(Number(ctx.args[0]), banned);
      return ctx.reply(ok ? `OK, user ${banned ? 'diblokir' : 'dibuka'}.` : 'User tidak ditemukan.');
    });
  bot.command('ban', banCmd(true));
  bot.command('unban', banCmd(false));

  bot.command(
    'bc',
    adminOnly(async (ctx) => {
      const text = ctx.payload?.trim();
      if (!text) return ctx.reply('Format: /bc <pesan>');
      const ids = store.activeUserIds();
      await ctx.reply(`Mengirim ke ${ids.length} pelanggan…`);
      // Jalan di latar belakang: bila ditunggu, bot berhenti membalas pelanggan lain selama broadcast
      (async () => {
        let ok = 0;
        for (const id of ids) {
          try {
            await ctx.telegram.sendMessage(id, `📢 ${text}`);
            ok++;
          } catch {
            // user memblokir bot
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        await worker.send(ctx.chat.id, `Broadcast selesai: ${ok}/${ids.length} terkirim.`);
      })().catch((e) => console.error('[bc]', e));
    }),
  );

  /* ----- input teks & foto sesuai langkah sesi ----- */

  /** Instruksi pembayaran deposit: gambar QRIS (bila ada) + teks rekening. */
  async function sendPaymentInstructions(ctx, chatId, depId, total) {
    const text = payment.paymentText();
    const body =
      (depId ? `🧾 <b>Deposit #${depId}</b>\n\n` : '🧾 <b>Pratinjau instruksi deposit</b>\n\n') +
      `Transfer <b>tepat</b> sebesar: <b>${rp(total)}</b>\n(3 digit terakhir adalah kode unik)\n\n` +
      (payment.hasQris() ? `📷 Scan QRIS di atas${text ? ', atau transfer ke:' : '.'}\n` : '') +
      (text ? `${esc(text)}\n\n` : '\n') +
      `Setelah transfer, <b>kirim foto bukti transfer</b> di chat ini.`;
    const extra = depId ? CANCEL_KB : {};

    if (payment.hasQris()) {
      try {
        // Caption foto maksimal 1024 karakter; bila lebih panjang teks dikirim terpisah
        if (body.length <= 1000) return await payment.sendQris(ctx.telegram, chatId, body, extra);
        await payment.sendQris(ctx.telegram, chatId, `🧾 QRIS ${esc(config.storeName)}`);
      } catch (e) {
        console.error('[qris] gagal mengirim gambar:', e.message);
      }
    }
    return ctx.telegram.sendMessage(chatId, body, { ...HTML, ...extra });
  }

  bot.on(['photo', 'document'], async (ctx) => {
    const s = getSession(ctx.from.id);
    const doc = ctx.message.document;
    const fileId = ctx.message.photo ? ctx.message.photo.at(-1).file_id : doc?.file_id;

    // Admin mengganti gambar QRIS (/setqris)
    if (s?.step === 'set_qris' && isAdmin(ctx.from.id)) {
      if (doc && !/^image\/(jpe?g|png)$/.test(doc.mime_type ?? '')) {
        return ctx.reply('Kirim gambar JPG/PNG.', CANCEL_KB);
      }
      if (doc && doc.file_size > 10 * 1024 * 1024) return ctx.reply('Ukuran gambar maksimal 10 MB.', CANCEL_KB);
      sessions.delete(ctx.from.id);
      try {
        await payment.saveQrisFromTelegram(ctx.telegram, fileId);
      } catch (e) {
        return ctx.reply(`Gagal menyimpan QRIS: ${e.message}`);
      }
      await ctx.reply('✅ Gambar QRIS diperbarui. Pratinjau yang dilihat pelanggan:');
      return sendPaymentInstructions(ctx, ctx.chat.id, null, config.minDeposit + 123);
    }

    if (!fileId || (doc && !doc.mime_type?.startsWith('image/'))) {
      return ctx.reply('Gunakan menu di bawah.', MAIN_MENU);
    }
    // Deposit dari sesi aktif; bila sesi sudah habis, pakai deposit terbaru yang belum ada buktinya
    let dep = s?.step === 'deposit_proof' ? store.getDeposit(s.depositId) : null;
    if (!dep || !['pending', 'expired'].includes(dep.status)) dep = store.depositAwaitingProof(ctx.from.id);
    if (!dep) {
      return ctx.reply(
        `Tidak ada deposit yang menunggu bukti transfer.\nBuat deposit dulu lewat ${BTN.deposit}.`,
        MAIN_MENU,
      );
    }
    sessions.delete(ctx.from.id);
    const reopened = dep.status === 'expired';
    if (!store.markDepositProof(dep.id)) return ctx.reply('Deposit ini sudah diproses.');
    dep = store.getDeposit(dep.id);

    const caption =
      depositCaption(dep, ctx.state.user) +
      '\n📎 Bukti transfer terlampir' +
      (reopened ? '\n♻️ Sempat kedaluwarsa, dibuka kembali' : '');
    for (const adminId of config.adminIds) {
      const send = ctx.message.photo ? ctx.telegram.sendPhoto : ctx.telegram.sendDocument;
      await send.call(ctx.telegram, adminId, fileId, { caption, ...HTML, ...depositKb(dep.id) }).catch(() => {});
    }
    return ctx.reply(
      `✅ Bukti transfer untuk deposit #${dep.id} (${rp(dep.amount)}) terkirim. Saldo masuk setelah dikonfirmasi admin.`,
      MAIN_MENU,
    );
  });

  bot.on('text', async (ctx) => {
    const uid = ctx.from.id;
    const s = getSession(uid);
    const text = ctx.message.text.trim();

    if (s?.step === 'tujuan') {
      const p = catalog.bySku(s.sku);
      if (!p) {
        sessions.delete(uid);
        return ctx.reply('Produk tidak ditemukan, silakan pilih ulang.', MAIN_MENU);
      }
      const parsed = s.fields ? parseByIsian(text, s.fields) : parseTujuan(text, s.kind, s.needZone);
      if (parsed.error) return ctx.reply(parsed.error, { ...HTML, ...CANCEL_KB });

      const next = {
        step: 'confirm',
        sku: p.sku,
        produk: p.nama,
        tujuan: parsed.tujuan,
        zone: parsed.zone,
        hargaModal: p.harga,
        hargaJual: catalog.sellPrice(p.harga),
      };
      setSession(uid, next);
      const v = confirmView(next, store.getUser(uid));
      return ctx.reply(v.text, { ...HTML, ...v.kb });
    }

    if (s?.step === 'deposit_amount') {
      const amount = Number(text.replace(/[^\d]/g, ''));
      if (!amount || amount < config.minDeposit || amount > config.maxDeposit) {
        return ctx.reply(`Nominal harus antara ${rp(config.minDeposit)} dan ${rp(config.maxDeposit)}.`, CANCEL_KB);
      }
      if (!isReady.deposit()) {
        sessions.delete(uid);
        return replyNotReady(ctx, 'deposit');
      }
      if (store.countPendingDeposits(uid) >= config.maxPendingDeposit) {
        sessions.delete(uid);
        return ctx.reply(
          `⚠️ Anda masih punya deposit yang menunggu konfirmasi.\n` +
            `Kirim foto bukti transfer untuk deposit tersebut, atau tunggu konfirmasi admin dulu.`,
          MAIN_MENU,
        );
      }
      // Kode unik 3 digit agar transfer mudah dicocokkan
      const total = amount + crypto.randomInt(1, 500);
      const depId = store.createDeposit(uid, total);
      setSession(uid, { step: 'deposit_proof', depositId: depId });

      const dep = store.getDeposit(depId);
      for (const adminId of config.adminIds) {
        worker.send(adminId, depositCaption(dep, ctx.state.user) + '\n⏳ Menunggu bukti transfer', depositKb(depId));
      }
      return sendPaymentInstructions(ctx, uid, depId, total);
    }

    return ctx.reply('Silakan pilih menu di bawah 👇', MAIN_MENU);
  });

  bot.catch((err, ctx) => {
    console.error(`[bot] error pada update ${ctx.updateType}:`, err);
  });

  return {
    commands: [
      { command: 'start', description: 'Menu utama' },
      { command: 'beli', description: 'Beli produk' },
      { command: 'saldo', description: 'Cek saldo' },
      { command: 'deposit', description: 'Isi saldo' },
      { command: 'riwayat', description: 'Riwayat transaksi' },
      { command: 'mutasi', description: 'Mutasi saldo' },
      { command: 'batal', description: 'Batalkan proses' },
      { command: 'bantuan', description: 'Bantuan' },
    ],
  };
}

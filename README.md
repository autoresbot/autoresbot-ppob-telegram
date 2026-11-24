# PPOB Bot Telegram

Bot Telegram untuk jualan pulsa, paket data, top up game, e-money & token PLN ke pelanggan, memakai
[API Pulsa & Game Autoresbot](https://autoresbot.com/dashboard/ppob/api).

📘 Cara kerja bot & panduan admin: lihat [PANDUAN.md](PANDUAN.md).

## Fitur

**Pelanggan**
- Katalog bertingkat: kategori → brand → produk (harga jual otomatis = modal + markup)
- Validasi tujuan: nomor HP (normalisasi +62/62 → 0), PLN 11–12 digit, Mobile Legends (User ID + Zone ID), ID game lain
- Konfirmasi pesanan; bila harga berubah, pelanggan diminta konfirmasi ulang
- Notifikasi otomatis saat transaksi sukses (beserta SN / token) atau gagal (saldo dikembalikan otomatis)
- Deposit manual dengan kode unik + kirim foto bukti transfer → admin menekan Terima/Tolak
- Riwayat 10 transaksi terakhir & mutasi saldo (`/mutasi`)
- Bukti transfer boleh dikirim kapan saja; deposit tanpa bukti otomatis kedaluwarsa
- Anti-spam (20 aksi / 10 detik per pelanggan)

**Admin** (`/admin`)
- `/stat`, `/laporan`, `/saldopusat`, `/addsaldo`, `/user`, `/mutasi`, `/markup`, `/deposits`, `/pending`, `/cektrx`, `/refund`, `/sukses`, `/refresh`, `/backup`, `/ban`, `/unban`, `/bc`
- Backup database otomatis harian (`data/backup/`)
- Peringatan otomatis ke admin bila saldo Autoresbot habis, IP belum di-whitelist, API key salah, API dinonaktifkan, dll.

## Keamanan transaksi

- Saldo pelanggan dipotong dan transaksi dicatat **dalam satu transaksi database** sebelum dikirim ke API
- Setiap pesanan punya `ref_id` unik. Bila terjadi timeout, 5xx, atau 429, pesanan dikirim ulang dengan `ref_id` yang **sama**, jadi tidak dobel
- Refund hanya dilakukan bila server pasti menolak (4xx / cut off) atau status akhirnya `refunded`. Hasil yang tidak pasti tidak pernah di-refund begitu saja
- Status dipantau dengan polling (5 detik di menit pertama, lalu 30 detik). Transaksi yang belum final tetap dilanjutkan walaupun bot di-restart
- `max_harga` dikirim agar tidak membeli bila harga pusat naik

## Persiapan

1. Node.js **22.13+** (SQLite bawaan Node, tanpa modul native)
2. Buat bot di [@BotFather](https://t.me/BotFather) untuk mendapatkan token
3. Di dashboard Autoresbot:
   - Ambil **API key** (Akun → API Key)
   - **Whitelist IP publik** server tempat bot berjalan (wajib)
   - Pastikan saldo cukup dan API Pulsa & Game **aktif**
4. Salin `.env.example` menjadi `.env`, lalu isi `BOT_TOKEN`, `AUTORESBOT_APIKEY`, `ADMIN_IDS`, dan `DEPOSIT_INFO`

### Konfigurasi belum lengkap?

Hanya `BOT_TOKEN` yang membuat bot berhenti bila kosong. Variabel lain yang belum diisi tidak menghentikan bot, tetapi fitur terkait dinonaktifkan:

| Variabel | Bila kosong |
|---|---|
| `AUTORESBOT_APIKEY` | Katalog & pembelian nonaktif; pelanggan melihat "Bot belum siap melayani transaksi" |
| `DEPOSIT_INFO` **dan** QRIS (data pembayaran) | Deposit nonaktif; pelanggan melihat "Fitur deposit belum tersedia" |
| `ADMIN_IDS` | Deposit nonaktif & tidak ada notifikasi admin |

Saat bot dijalankan, daftar konfigurasi yang kurang ditampilkan di konsol dan dikirim ke admin. Admin bisa mengeceknya kapan saja dengan `/config`. Nilai contoh seperti `apikey_xxxx` dianggap belum diisi.

### Data pembayaran deposit (QRIS & rekening)

Isi minimal salah satu, atau keduanya:

- **Gambar QRIS** disimpan di `assets/qris.jpg` (bisa diubah lewat `QRIS_PATH`). Ada dua cara menggantinya:
  - Dari Telegram: admin mengirim `/setqris`, lalu mengirim gambar QRIS (sebaiknya sebagai *File* agar tidak dikompres)
  - Manual: timpa file `assets/qris.jpg`. Tidak perlu restart, karena gambar baru otomatis dipakai
- **Teks rekening / e-wallet** diambil dari `DEPOSIT_INFO` di `.env`, atau diatur lewat `/setpayment <teks>` (boleh beberapa baris). Kirim `/setpayment -` untuk kembali ke `.env`

Perintah lain: `/payment` untuk melihat pratinjau instruksi deposit seperti yang dilihat pelanggan, dan `/hapusqris` untuk menghapus gambar QRIS.

`assets/qris-contoh.jpg` hanya **contoh tampilan** (bertanda "CONTOH") dan tidak pernah dikirim ke pelanggan.

## Menjalankan

```bash
npm install
npm start
```

Saat pengembangan: `npm run dev` (otomatis restart bila file berubah).

Untuk menjalankan di server terus-menerus, gunakan PM2:

```bash
npm i -g pm2
pm2 start npm --name ppob-bot -- start
pm2 save
```

## Struktur

```
src/
  index.js     entry point
  config.js    membaca .env
  setup.js     cek kelengkapan konfigurasi (/config)
  payment.js   data pembayaran: QRIS + teks rekening
  ppob.js      klien API Autoresbot + klasifikasi error
  db.js        SQLite: users, mutations (buku besar), transactions, deposits, settings
  catalog.js   cache produk (refresh 15 menit) + harga jual
  worker.js    kirim transaksi, kirim ulang, polling status, notifikasi, penyelesaian manual
  jobs.js      backup harian & kedaluwarsa deposit
  bot.js       handler Telegram (menu, beli, deposit, admin)
  validate.js  validasi format tujuan
  errors.js    pesan error ramah pelanggan
data/bot.db    database (dibuat otomatis)
data/backup/   backup harian
```

## Versi & rilis

Versi bot ada di `package.json` (saat ini mulai dari `0.1.0`) dan tampil di konsol saat bot berjalan, di `/admin`, `/stat`, dan `/versi`. Riwayat perubahan ada di [CHANGELOG.md](CHANGELOG.md).

Cara merilis versi baru:

1. Catat perubahan di bagian **[Belum dirilis]** pada `CHANGELOG.md`, lalu ubah judulnya menjadi nomor versi baru beserta tanggalnya
2. Naikkan versi sekaligus buat commit & tag git:
   ```bash
   npm version patch   # 0.1.0 → 0.1.1  (perbaikan bug)
   npm version minor   # 0.1.0 → 0.2.0  (fitur baru)
   ```
3. Restart bot di server

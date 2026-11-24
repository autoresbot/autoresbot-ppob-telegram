# Panduan PPOB Bot

Dokumen ini punya dua bagian:

1. **Cara kerja bot**: apa yang terjadi saat pelanggan membeli atau deposit, dan bagaimana uang dijaga agar tidak hilang atau terpotong dua kali.
2. **Panduan admin**: persiapan awal, tugas harian, daftar perintah, dan cara menangani masalah.

Instalasi teknis (Node.js, `.env`, PM2) ada di [README.md](README.md).

---

## Bagian 1: Cara kerja bot

### Gambaran besar

```
 Pelanggan ──Telegram──▶  BOT (server Anda)  ──API──▶  Autoresbot  ──▶  Operator / Game / PLN
                           │
                           ├─ data/bot.db   saldo pelanggan, transaksi, deposit, pengaturan
                           └─ worker        memantau status transaksi tiap 5–30 detik
```

Ada **dua saldo** yang berbeda:

| Saldo | Milik | Diisi lewat | Dipakai untuk |
|---|---|---|---|
| **Saldo pelanggan** | Tiap pelanggan, dicatat di database bot | Deposit ke rekening/QRIS **Anda**, lalu dikonfirmasi admin | Membayar pembelian di bot |
| **Saldo pusat** | Akun Autoresbot Anda | Isi saldo di dashboard Autoresbot | Dipotong Autoresbot setiap ada transaksi (harga modal) |

Uang deposit pelanggan masuk ke rekening Anda. Anda sendiri yang harus menjaga **saldo pusat** di Autoresbot tetap cukup. Bila saldo pusat habis, transaksi pelanggan gagal (saldo pelanggan dikembalikan) dan admin mendapat peringatan.

### Harga jual

```
harga jual = harga modal + (harga modal × MARKUP_PERCENT%) + MARKUP_FLAT, lalu dibulatkan ke atas ke kelipatan ROUND_TO
```

Contoh: modal Rp10.120, markup Rp500 + 0%, pembulatan 50 menghasilkan Rp10.620 → **Rp10.650**.

- Daftar produk & harga modal diambil ulang dari Autoresbot **setiap 15 menit** (atau segera dengan `/refresh`).
- Markup bisa diubah kapan saja dengan `/markup` tanpa restart.
- Produk bertanda ⛔ sedang gangguan atau cut off dan tidak bisa dibeli.

### Alur pembelian

1. Pelanggan memilih **🛒 Beli Produk**, lalu kategori, brand, dan produk.
2. Bot meminta nomor/ID tujuan sesuai jenis produk lalu memeriksa formatnya:
   - Pulsa/data/e-money: nomor HP. `+62` / `62` otomatis diubah menjadi `0`.
   - Token PLN: 11–12 digit.
   - Mobile Legends (dan game lain yang butuh zone): `UserID ZoneID`, misalnya `12345678 1234`.
   - Game lain: ID 3–40 karakter.
3. Bot menampilkan **konfirmasi** (produk, tujuan, harga, saldo). Pelanggan menekan **✅ Bayar**.
4. Bila harga pusat berubah sejak konfirmasi, pelanggan diminta konfirmasi ulang dengan harga baru.
5. **Saldo pelanggan dipotong** dan transaksi dicatat sekaligus, lalu pesanan dikirim ke Autoresbot.
6. Worker memantau status sampai selesai, lalu mengirim notifikasi ke pelanggan:
   - ✅ **Sukses**, beserta SN / token PLN.
   - ❌ **Gagal**, dan saldo pelanggan **dikembalikan otomatis**.

### Status transaksi

| Status di bot | Arti | Yang terjadi |
|---|---|---|
| `submitting` | Baru dibuat, sedang dikirim ke API | Dikirim (ulang) otomatis |
| `unknown` | Pengiriman tidak pasti (timeout / server lambat) | Dikirim ulang dengan `ref_id` yang sama selama 10 menit, lalu dicek statusnya |
| `processing` | Sedang diproses operator | Dicek tiap 5 detik di menit pertama, lalu tiap 30 detik |
| `review` | Sedang diperiksa admin Autoresbot | Dicek tiap 60 detik sampai sukses/refund |
| `success` | Berhasil | Final, pelanggan dapat SN |
| `refunded` / `failed` | Gagal | Final, saldo pelanggan dikembalikan |

### Kenapa uang aman

- **Tidak dobel.** Setiap pesanan punya `ref_id` unik. Bila koneksi putus atau server lambat, pesanan dikirim ulang dengan `ref_id` yang **sama**, dan Autoresbot tidak akan memotong dua kali.
- **Tidak refund sembarangan.** Saldo pelanggan hanya dikembalikan bila server **pasti** menolak (misalnya nomor salah, stok habis, saldo pusat kurang) atau statusnya berakhir `refunded`. Bila hasilnya belum pasti, bot terus mengecek, tidak langsung refund.
- **Tahan restart.** Transaksi yang belum selesai tersimpan di database dan otomatis dilanjutkan saat bot dinyalakan lagi.
- **`max_harga`.** Bot mengirim harga modal yang dilihat pelanggan. Bila harga pusat naik di atas itu, transaksi ditolak (lalu refund), bukan dibeli dengan harga lebih mahal.
- **Buku besar.** Setiap perubahan saldo pelanggan (deposit, beli, refund, koreksi admin) tercatat di tabel `mutations` beserta saldo setelahnya.

### Alur deposit

1. Pelanggan memilih **➕ Deposit** dan mengetik nominal (antara `MIN_DEPOSIT` dan `MAX_DEPOSIT`).
2. Bot menambahkan **kode unik** acak (Rp1–Rp499), misalnya Rp50.000 menjadi **Rp50.237**, lalu menampilkan QRIS dan/atau teks rekening.
3. Admin langsung mendapat pesan **"Deposit #N … ⏳ Menunggu bukti transfer"** dengan tombol Terima/Tolak.
4. Pelanggan transfer **tepat** sebesar nominal tersebut dan mengirim **foto bukti transfer** ke bot. Bukti boleh dikirim kapan saja; bot otomatis memasangkannya ke deposit terbaru pelanggan yang belum ada buktinya.
5. Admin mendapat pesan kedua yang berisi foto bukti dan tombol yang sama.
6. Admin mengecek mutasi rekening/QRIS, lalu menekan **✅ Terima** (saldo pelanggan bertambah sebesar nominal **termasuk kode unik**) atau **❌ Tolak**.
7. Pelanggan mendapat notifikasi hasilnya.

Satu deposit hanya bisa diproses sekali. Bila dua admin menekan tombol bersamaan, yang kedua mendapat pesan "sudah diproses".

**Kedaluwarsa & batas.** Deposit yang **tidak pernah dikirim buktinya** otomatis kedaluwarsa setelah `DEPOSIT_EXPIRE_HOURS` jam (bawaan 24), dan pelanggan diberi tahu. Bila pelanggan ternyata sudah transfer dan mengirim bukti dalam 7 hari, deposit itu **dibuka kembali** dan admin mendapat pesan bertanda ♻️. Deposit yang sudah ada buktinya tidak pernah kedaluwarsa. Satu pelanggan maksimal punya `MAX_PENDING_DEPOSIT` deposit menunggu (bawaan 3).

### Perlindungan lain

- **Anti-spam.** Pelanggan yang mengirim lebih dari 20 pesan/tombol dalam 10 detik diabaikan sementara (admin tidak dibatasi).
- **Backup harian.** Database dicadangkan otomatis sekali sehari ke `data/backup/` (`bot-YYYYMMDD-HHmm.db`, jam WIB). Hanya `BACKUP_KEEP` file terbaru yang disimpan (bawaan 7). Bila backup gagal, admin mendapat peringatan.

---

## Bagian 2: Panduan admin

### Siapa admin?

Admin adalah akun Telegram yang ID-nya tercantum di `ADMIN_IDS` pada file `.env` (pisahkan dengan koma bila lebih dari satu). Cek ID Anda di [@userinfobot](https://t.me/userinfobot). Setelah mengubah `.env`, **restart bot**.

Ketik `/admin` di bot untuk melihat daftar perintah.

### Checklist persiapan sebelum buka toko

- [ ] `BOT_TOKEN`, `AUTORESBOT_APIKEY`, `ADMIN_IDS` sudah diisi di `.env`
- [ ] **IP publik server** sudah di-whitelist di dashboard Autoresbot
- [ ] API Pulsa & Game di dashboard Autoresbot berstatus **aktif**
- [ ] Saldo pusat Autoresbot sudah diisi. Cek dengan `/saldopusat`
- [ ] Data pembayaran sudah diatur: `/setqris` (kirim gambar QRIS) dan/atau `/setpayment`
- [ ] `/payment` menampilkan instruksi deposit yang benar
- [ ] `/config` menunjukkan **✅ Konfigurasi lengkap**
- [ ] `/markup` sudah sesuai keuntungan yang diinginkan
- [ ] Uji coba: deposit kecil dari akun lain, terima, lalu beli 1 produk murah

### Tugas harian

| Kapan | Lakukan |
|---|---|
| Ada notifikasi deposit masuk | Cek mutasi rekening/QRIS → **Terima** bila nominal cocok persis (termasuk kode unik), **Tolak** bila tidak ada dana masuk |
| Pagi hari | `/saldopusat`: pastikan saldo pusat cukup untuk perkiraan transaksi hari itu |
| Sesekali | `/deposits`: lihat deposit yang masih menunggu konfirmasi |
| Sesekali | `/pending`: lihat transaksi yang belum selesai. Yang berumur lebih dari 1 jam layak dicek dengan `/cektrx` |
| Akhir hari | `/stat`: omzet dan laba hari ini (dihitung dari pukul 00.00 WIB) |
| Akhir minggu/bulan | `/laporan minggu`, `/laporan bulan`, atau `/laporan semua`: rekap per hari/bulan & produk terlaris |

### Daftar perintah admin

**Konfigurasi & pembayaran**

| Perintah | Fungsi |
|---|---|
| `/admin` | Daftar perintah admin |
| `/config` | Cek konfigurasi yang belum lengkap & dampaknya |
| `/setqris` | Ganti gambar QRIS. Setelah perintah ini, kirim gambar QRIS (sebaiknya sebagai **File** agar tidak buram) |
| `/hapusqris` | Hapus gambar QRIS |
| `/setpayment <teks>` | Ganti teks rekening/e-wallet, boleh beberapa baris. `/setpayment -` kembali memakai `DEPOSIT_INFO` di `.env` |
| `/payment` | Pratinjau instruksi deposit seperti yang dilihat pelanggan |

Contoh `/setpayment`:

```
/setpayment Transfer ke salah satu:
BCA 1234567890 a.n. Toko Saya
DANA 081234567890 a.n. Toko Saya
```

**Keuangan & produk**

| Perintah | Fungsi |
|---|---|
| `/stat` | Jumlah pelanggan, total saldo pelanggan, transaksi sukses, omzet & laba hari ini, transaksi berjalan |
| `/laporan [periode]` | Rekap omzet, laba & margin, rata-rata per transaksi, transaksi gagal, deposit diterima, pelanggan baru, rincian per periode & 5 produk terlaris. Di bawah laporan ada tombol untuk pindah periode dan 🔄 Perbarui |
| `/saldopusat` | Saldo akun Autoresbot |
| `/markup` | Lihat markup saat ini |
| `/markup <flat> [persen]` | Ubah markup. Contoh: `/markup 1000` (Rp1.000 per produk) atau `/markup 500 2` (Rp500 + 2%) |
| `/refresh` | Muat ulang daftar produk & harga dari Autoresbot sekarang |

Periode `/laporan`:

| Ketik | Periode | Rincian |
|---|---|---|
| `/laporan` atau `/laporan hari` | Hari ini, sejak 00.00 WIB | — |
| `/laporan minggu` | Minggu ini, sejak Senin 00.00 WIB | per hari |
| `/laporan bulan` | Bulan ini, sejak tanggal 1 | per hari |
| `/laporan semua` | Sejak transaksi pertama | per bulan |
| `/laporan 30` | N hari terakhir (1–365) | per hari; per bulan bila lebih dari 62 hari |

Bisa juga ditulis `harian`, `mingguan`, `bulanan`.

**Pelanggan**

| Perintah | Fungsi |
|---|---|
| `/user <id>` | Info pelanggan: nama, saldo, status, 5 transaksi terakhir |
| `/mutasi <id>` | 15 mutasi saldo terakhir pelanggan (deposit, beli, refund, koreksi admin) beserta saldo setelahnya. Pelanggan sendiri bisa mengetik `/mutasi` untuk melihat miliknya |
| `/addsaldo <id> <jumlah>` | Tambah saldo, misalnya `/addsaldo 123456789 50000`. Pakai angka minus untuk mengurangi: `/addsaldo 123456789 -10000`. Pelanggan mendapat notifikasi |
| `/ban <id>` / `/unban <id>` | Blokir / buka blokir pelanggan |
| `/bc <pesan>` | Broadcast ke semua pelanggan yang tidak diblokir. Berjalan di latar belakang; Anda dapat laporan "Broadcast selesai" setelahnya |

ID pelanggan terlihat di pesan deposit, atau pelanggan bisa melihatnya sendiri lewat **💰 Saldo**.

**Transaksi & deposit**

| Perintah | Fungsi |
|---|---|
| `/deposits` | Tampilkan hingga 10 deposit yang menunggu, lengkap dengan tombol Terima/Tolak |
| `/pending` | Daftar transaksi yang belum selesai (paling lama dulu), lengkap dengan umur & `ref_id` |
| `/cektrx <ref_id>` | Bandingkan data transaksi di bot dan di server Autoresbot. `ref_id` (mis. `TG123456789-…`) ada di notifikasi pelanggan |
| `/refund <ref_id> [paksa]` | Batalkan transaksi yang belum final & kembalikan saldo pelanggan |
| `/sukses <ref_id> [SN] [paksa]` | Tandai transaksi sukses secara manual, opsional dengan SN |

**Sistem**

| Perintah | Fungsi |
|---|---|
| `/versi` | Versi bot, versi Node.js, dan sejak kapan bot berjalan |
| `/backup` | Buat backup database sekarang dan kirim filenya ke chat Anda. File ini rahasia (berisi saldo pelanggan) |

### Menyelesaikan transaksi secara manual (`/refund`, `/sukses`)

Pakai hanya untuk transaksi yang macet lama. Bot **selalu mengecek server dulu**:

| Status di server | `/refund <ref>` | `/sukses <ref>` |
|---|---|---|
| `success` / `refunded` (sudah final) | Bot menyamakan dengan server, bukan dengan perintah Anda | Sama |
| Transaksi **tidak ada** di server | ✅ Langsung refund (pesanan memang tidak pernah terkirim) | ⛔ Ditolak, gunakan `/refund` |
| `processing` / `review`, atau server tidak bisa dicek | ⛔ Ditolak kecuali ditambah `paksa` | ⛔ Ditolak kecuali ditambah `paksa` |

**Hati-hati dengan `paksa`.** Setelah dipaksa, bot berhenti memantau transaksi itu.
- Refund paksa, lalu ternyata server sukses: pelanggan dapat produk **dan** saldonya kembali (Anda rugi).
- Sukses paksa, lalu ternyata server refund: pelanggan tidak dapat produk dan tidak di-refund. Dananya kembali ke saldo pusat Anda, jadi kembalikan ke pelanggan dengan `/addsaldo`.

Contoh: `/sukses TG123456789-ABC123 1234-5678-9012-3456-7890 paksa`.

### Peringatan otomatis ke admin

Bot mengirim pesan **⚠️ PPOB error** bila ada masalah yang perlu tindakan Anda. Transaksi pelanggan yang terkena sudah otomatis gagal dan saldonya dikembalikan.

| Kode | Artinya | Tindakan |
|---|---|---|
| `INSUFFICIENT_BALANCE` | Saldo pusat Autoresbot kurang | Isi saldo di dashboard Autoresbot |
| `IP_NOT_WHITELISTED` | IP server belum di-whitelist (IP-nya tertulis di pesan) | Tambahkan IP tersebut di dashboard Autoresbot |
| `UNAUTHORIZED` | API key salah / kosong | Periksa `AUTORESBOT_APIKEY` di `.env`, lalu restart |
| `ACCOUNT_INACTIVE` | Akun Autoresbot belum verifikasi email atau diblokir | Cek akun di dashboard |
| `API_DISABLED` | API Pulsa & Game dinonaktifkan | Hubungi Autoresbot / aktifkan di dashboard |
| `REF_ID_CONFLICT`, `INVALID_REF_ID`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE` | Kesalahan sistem bot | Catat `ref_id`, cek log bot |

### Menangani keluhan pelanggan

**"Saya sudah transfer tapi saldo belum masuk."**
Pastikan pelanggan sudah mengirim foto bukti (boleh kapan saja, juga setelah deposit kedaluwarsa). Lalu cek `/deposits`. Bila depositnya ada dan dana memang masuk, tekan **Terima**. Bila pelanggan transfer dengan nominal berbeda, Anda bisa **Tolak** deposit itu lalu tambahkan saldo sesuai dana yang benar-benar masuk dengan `/addsaldo`.

**"Transaksi saya lama sekali / masih diproses."**
Jalankan `/cektrx <ref_id>`. Status `processing` atau `review` berarti masih ditangani pusat. Dana aman, dan bot akan mengirim notifikasi otomatis begitu statusnya final. Jangan mengembalikan saldo manual selama status belum final, karena transaksinya bisa saja masih berhasil dan saldo jadi kembali dua kali. Bila sudah sangat lama, lihat bagian *Menyelesaikan transaksi secara manual*.

**"Transaksi sukses tapi pulsa/token belum masuk."**
Berikan SN dari notifikasi atau dari `/cektrx` ke pelanggan. SN adalah bukti dari operator. Bila tetap bermasalah, ajukan komplain ke Autoresbot dengan `ref_id` tersebut.

**"Gagal terus saat jam 23.30–00.30."**
Itu jadwal **cut off harian** Autoresbot. Minta pelanggan mencoba lagi setelah 00.30 WIB.

**"Produk yang sama ke nomor yang sama ditolak."**
Autoresbot menolak pembelian nominal yang sama ke nomor yang sama dalam waktu berdekatan (`DUPLICATE_TRANSACTION`) untuk mencegah dobel. Tunggu ±2 menit; untuk produk tertentu baru bisa besok.

### Perawatan

- **Backup database.** Semua saldo pelanggan ada di `data/bot.db`. Bot membuat backup harian otomatis di `data/backup/`, tetapi folder itu ada di server yang sama. Simpan juga salinan di tempat lain secara rutin, misalnya dengan `/backup` lalu simpan filenya.
- **Reset ke kondisi baru.** Hentikan bot, lalu jalankan `npm run reset` di folder bot. Semua pelanggan, saldo, transaksi, deposit, markup, teks pembayaran, dan QRIS dihapus, sehingga **saldo pelanggan hilang**. Pakai hanya untuk uji coba atau memulai toko dari awal. Data lama tetap disalin ke `data/backup/sebelum-reset-*` kecuali Anda memakai `npm run reset -- --semua`.
- **Memulihkan backup.** Hentikan bot, hapus `data/bot.db`, `bot.db-wal`, dan `bot.db-shm`, salin file backup menjadi `data/bot.db`, lalu jalankan bot lagi.
- **Jangan bagikan** file `.env`, karena berisi token bot dan API key. Bila API key bocor, ganti di dashboard Autoresbot.
- **Versi bot** bisa dicek dengan `/versi`. Daftar perubahan tiap versi ada di [CHANGELOG.md](CHANGELOG.md).
- **Restart** diperlukan setelah mengubah `.env`. Perubahan lewat perintah bot (`/markup`, `/setqris`, `/setpayment`) langsung berlaku tanpa restart.
- **Log.** Bila memakai PM2, lihat log dengan `pm2 logs ppob-bot`.

### Batasan yang perlu diketahui

- Konfirmasi deposit masih **manual**; tidak ada pengecekan mutasi bank otomatis.
- Rincian laporan menampilkan maksimal 31 baris terakhir (31 hari atau 31 bulan); total di atasnya tetap mencakup seluruh periode.
- Bot hanya melayani **chat pribadi**; pesan di grup diabaikan.

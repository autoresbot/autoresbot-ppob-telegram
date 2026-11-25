# Changelog

Semua perubahan penting pada bot dicatat di sini.
Format versi mengikuti [Semantic Versioning](https://semver.org/lang/id/): `MAYOR.MINOR.PATCH`.

- **PATCH** (0.1.**1**): perbaikan bug, tanpa fitur baru
- **MINOR** (0.**2**.0): fitur baru yang tidak merusak data/konfigurasi lama
- **MAYOR** (**1**.0.0): rilis stabil pertama, atau perubahan yang butuh penyesuaian `.env`/database secara manual

Selama versi masih `0.x`, bot dianggap tahap awal dan perilakunya masih bisa berubah.

## [Belum dirilis]

## [0.2.0] - 2026-11-25

### Ditambahkan
- `npm run zip`: buat zip source code siap bagi di `release/` (dari commit terakhir, tanpa `.env`/database/QRIS asli)
- `npm run reset`: kembalikan bot ke kondisi baru (hapus database & QRIS), dengan konfirmasi, backup otomatis, dan cek bot sedang berjalan. `--semua` untuk ikut menghapus backup
- Bot menulis `data/bot.pid` saat berjalan
- `/laporan minggu` (sejak Senin) dan `/laporan semua` (rincian per bulan), serta tombol pindah periode & 🔄 Perbarui
- Laporan menampilkan margin laba (%) dan rata-rata nilai per transaksi
- Info error detail khusus owner/admin: bila produk gagal dimuat (mis. `IP_NOT_WHITELISTED`), admin melihat kode error, pesan server, dan **langkah perbaikan** (mis. IP yang harus di-whitelist) di menu Beli, `/start`, `/config`, `/refresh`, `/saldopusat`, dan konsol. Pelanggan tetap melihat pesan umum
- Notifikasi otomatis ke admin saat koneksi ke Autoresbot bermasalah (sekali per jenis error) dan saat pulih
- Tombol 🔄 Coba lagi (admin) untuk memuat ulang produk; saat gagal bot mencoba ulang tiap 1 menit (sebelumnya 15 menit)
- Bila admin sendiri yang membeli dan gagal, admin mendapat kode & pesan error asli dari server

### Diperbaiki
- Validasi nomor/ID tujuan kini memakai aturan resmi dari API (`isian`: label, pola, contoh) per produk, sehingga isian yang salah ditolak sebelum dibayar (mis. Aktivasi Voucher wajib nomor HP). Validasi lama dipakai sebagai cadangan bila detail produk tidak bisa diambil
- Isian dua bagian untuk game ber-ID tunggal (mis. `12345678 1234` di Magic Chess) tidak lagi digabung diam-diam; pelanggan diminta menulis tanpa spasi
- Info cut off tampil "[object Object]": format `cut_off` dari API ternyata objek `{mulai, selesai}`

### Diubah
- `/laporan` tanpa argumen sekarang menampilkan **hari ini** (sebelumnya 7 hari terakhir); batas `/laporan N` naik dari 90 menjadi 365 hari

## [0.1.0] - 2026-11-24

Versi awal.

### Pelanggan
- Katalog bertingkat (kategori → brand → produk) dengan harga jual otomatis (modal + markup)
- Validasi tujuan: nomor HP, token PLN, Mobile Legends (User ID + Zone ID), ID game lain
- Konfirmasi pesanan, dengan konfirmasi ulang bila harga berubah
- Notifikasi otomatis sukses (dengan SN/token) atau gagal (saldo dikembalikan)
- Deposit manual dengan kode unik, QRIS dan/atau teks rekening, serta kirim bukti transfer
- Bukti transfer boleh dikirim kapan saja; deposit tanpa bukti kedaluwarsa otomatis
- Riwayat transaksi (`/riwayat`) dan mutasi saldo (`/mutasi`)
- Anti-spam: 20 aksi per 10 detik

### Admin
- Konfigurasi & pembayaran: `/config`, `/setqris`, `/hapusqris`, `/setpayment`, `/payment`
- Keuangan: `/stat`, `/laporan`, `/saldopusat`, `/markup`, `/refresh`
- Pelanggan: `/user`, `/mutasi`, `/addsaldo`, `/ban`, `/unban`, `/bc`
- Transaksi & deposit: `/deposits`, `/pending`, `/cektrx`, `/refund`, `/sukses`
- Sistem: `/backup`, `/versi`
- Peringatan otomatis untuk saldo pusat habis, IP belum di-whitelist, API key salah, dll.

### Sistem
- Saldo dipotong & transaksi dicatat secara atomik; `ref_id` unik sehingga tidak dobel saat dikirim ulang
- Polling status (5 detik di menit pertama, lalu 30 detik) yang tetap berlanjut setelah restart
- Backup database otomatis harian ke `data/backup/`

[Belum dirilis]: https://github.com/autoresbot/autoresbot-ppob-telegram/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/autoresbot/autoresbot-ppob-telegram/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/autoresbot/autoresbot-ppob-telegram/releases/tag/v0.1.0

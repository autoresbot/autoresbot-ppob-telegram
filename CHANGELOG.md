# Changelog

Semua perubahan penting pada bot dicatat di sini.
Format versi mengikuti [Semantic Versioning](https://semver.org/lang/id/): `MAYOR.MINOR.PATCH`.

- **PATCH** (0.1.**1**): perbaikan bug, tanpa fitur baru
- **MINOR** (0.**2**.0): fitur baru yang tidak merusak data/konfigurasi lama
- **MAYOR** (**1**.0.0): rilis stabil pertama, atau perubahan yang butuh penyesuaian `.env`/database secara manual

Selama versi masih `0.x`, bot dianggap tahap awal dan perilakunya masih bisa berubah.

## [Belum dirilis]

### Ditambahkan
- `npm run reset`: kembalikan bot ke kondisi baru (hapus database & QRIS), dengan konfirmasi, backup otomatis, dan cek bot sedang berjalan. `--semua` untuk ikut menghapus backup
- Bot menulis `data/bot.pid` saat berjalan

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

[Belum dirilis]: #
[0.1.0]: #

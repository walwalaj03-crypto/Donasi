# Donasi Untuk Beli HP

Website donasi QRIS siap deploy ke Railway.

## Deploy ke Railway
1. Upload folder project ini ke GitHub (jangan upload `.env` atau token).
2. Di Railway pilih **New Project → Deploy from GitHub Repo**.
3. Setelah deploy, buka **Variables** pada service dan tambahkan:
   - `ACCOUNT_ID` = Account ID BuatQRIS
   - `SECRET_TOKEN` = secret token baru dari BuatQRIS
   - `DONATION_GOAL` = `2700000`
   - `QRIS_BASE_URL` = `https://api.buatqris.site`
   - `QRIS_METHOD` = `qris_two` (atau `qris_five` sesuai akun)
   - `FEE_BY` = `user` (atau `buyer`)
   - `DB_PATH` = `/data/donations.db`
4. Tambahkan Railway **Volume** ke service dan mount path `/data`. Ini penting agar catatan transaksi dan total donasi tidak hilang saat redeploy/restart.
5. Railway akan menjalankan `npm start`. Tidak perlu mengatur port manual; Railway mengisi `PORT`.

## Catatan
- Secret token hanya digunakan di backend; jangan masukkan ke HTML atau JavaScript browser.
- Total donasi bertambah hanya setelah status transaksi terkonfirmasi `success`.
- Pemeriksaan status otomatis dilakukan setiap 22 detik agar tidak melanggar batas 1 kali per 20 detik per transaksi.
- Database SQLite berada di volume `/data`.
- Untuk keamanan, batasi akses dashboard Railway dan rotasi token bila pernah dibagikan.

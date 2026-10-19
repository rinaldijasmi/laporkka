# LaporKKA

Formulir laporan mahasiswa dan dashboard petugas KKA. Server HTTP bawaan Node.js menggunakan Supabase REST/Auth/Storage untuk backend; analisis pasal menggunakan OpenAI API dengan teks laporan yang sudah disamarkan.

## Struktur proyek

```
public/      halaman statis (index.html, admin.html), css/, js/, assets/ (PDF Kode Etik)
src/         server.js dan lib/ (analisis AI, privasi)
scripts/     create-user.js
supabase/    migrations SQL (jalankan berurutan)
test/        tes unit
```

GitHub Pages hanya dapat menyajikan folder `public/`; backend Node.js harus dihosting terpisah.

## Menyiapkan backend

1. Buat project Supabase, lalu buka **SQL Editor** dan jalankan [`001_initial_schema.sql`](./supabase/migrations/001_initial_schema.sql), lalu [`002_add_selesai_status.sql`](./supabase/migrations/002_add_selesai_status.sql).
2. Salin `.env.example` menjadi `.env`, lalu isi `SUPABASE_URL`, `SUPABASE_ANON_KEY`, dan `SUPABASE_SERVICE_ROLE_KEY` dari pengaturan project Supabase. Jangan pernah menaruh service-role key atau OpenAI API key di file frontend atau commit ke git.
3. Isi `OPENAI_API_KEY` untuk mengaktifkan analisis. Kunci hanya dibaca server.
4. Pasang dependency dan jalankan server:

   ```sh
   npm install
   npm start
   ```

5. Buat akun Admin pertama dan akun petugas lain dari terminal:

   ```sh
   npm run create-user
   ```

   Perintah meminta username, peran, dan password secara interaktif. Pendaftaran akun publik tidak tersedia.

6. Buka `http://localhost:3000`. Dashboard petugas tersedia di `/admin.html`.

Di production, set `APP_ORIGIN` ke origin HTTPS aplikasi dan `SESSION_COOKIE_SECURE=true`. Jangan deploy service-role key ke browser.

## Peran

Admin dapat melihat seluruh laporan dan menugaskannya kepada akun aktif dengan peran `PKKM`, `PKM`, `ASUS`, `Akademik`, atau unit Kemahasiswaan yang tersedia. Petugas selain Admin hanya dapat melihat laporan yang ditugaskan kepadanya.

## Batas pemrosesan AI

AI menerima kategori, tanggal/waktu kejadian, dan kronologi setelah nama pelapor/terlapor, NIM, email, dan nomor telepon dihapus atau disamarkan. Identitas terpisah, lokasi kejadian, serta file bukti tidak dikirim ke OpenAI. Analisis dicocokkan dengan kutipan teks dari PDF Kode Etik yang disimpan di aplikasi. Hasilnya merupakan rekomendasi untuk pratinjau Admin, bukan keputusan atau penetapan pelanggaran. Admin harus memverifikasi pasal dan konteks secara mandiri.

## API utama

- `POST /api/reports` — menyimpan laporan dan bukti privat; mengembalikan token pelacakan sekali saja.
- `POST /api/reports/track` — mengembalikan status dan catatan tindak lanjut berdasarkan token.
- `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout` — autentikasi username/password dengan cookie HttpOnly.
- `GET /api/admin/reports` — daftar laporan sesuai peran dan penugasan.
- `PATCH /api/admin/reports/:id/assignment` — penugasan oleh Admin.
- `PATCH /api/admin/reports/:id` — perubahan status dan catatan tindak lanjut.

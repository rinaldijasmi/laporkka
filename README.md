# LaporKKA

Formulir laporan mahasiswa dan dashboard petugas KKA.

- **Frontend** (`public/`): HTML/CSS/JS statis di Cloudflare Pages.
- **Backend** (`supabase/functions/api`): satu Supabase Edge Function untuk laporan, pelacakan, login petugas, penugasan, dan analisis AI.
- **Data**: Supabase Auth, Postgres, dan private Storage. Analisis pasal memakai OpenAI dengan teks laporan yang sudah disamarkan.

## Struktur proyek

```
public/                    situs statis (index.html, admin.html, css/, js/, assets/)
  js/config.js             alamat Edge Function
supabase/
  functions/api/           API (Edge Function)
  functions/_shared/       analisis AI, penyamaran data, articles.json (pasal Kode Etik)
  migrations/              SQL, jalankan berurutan
  config.toml
scripts/                   create-user.js, build-articles.js, serve-public.js
test/                      tes unit
.github/workflows/         deploy Cloudflare Pages
```

## Menyiapkan backend

1. Di Supabase **SQL Editor**, jalankan [`001_initial_schema.sql`](./supabase/migrations/001_initial_schema.sql) lalu [`002_add_selesai_status.sql`](./supabase/migrations/002_add_selesai_status.sql).
2. Login dan deploy fungsi:

   ```sh
   supabase login
   supabase functions deploy api --project-ref <PROJECT_REF> --no-verify-jwt
   ```

3. Atur secret fungsi (`SUPABASE_URL`, anon key, dan service-role key sudah disediakan Supabase otomatis):

   ```sh
   supabase secrets set ALLOWED_ORIGINS=https://USERNAME.github.io OPENAI_API_KEY=... OPENAI_MODEL=gpt-4.1-mini --project-ref <PROJECT_REF>
   ```

4. Salin `.env.example` menjadi `.env` (hanya untuk skrip lokal), lalu buat akun petugas pertama:

   ```sh
   npm install
   npm run create-user
   ```

   Ini hanya untuk Admin pertama. Akun petugas lain dibuat Admin lewat tombol **Kelola Akun** di dashboard; pendaftaran publik tidak tersedia.

Jika PDF Kode Etik diganti, jalankan `npm run build:articles` lalu deploy ulang fungsi.

## Konfigurasi frontend

`public/js/config.js` harus berisi `https://<PROJECT_REF>.supabase.co/functions/v1/api`. `ALLOWED_ORIGINS` harus berisi origin situs (tanpa path, mis. `https://lapor.kkatelkomuniversity.com`).

## Deploy frontend ke Cloudflare Pages

```bash
npx wrangler login                     # sekali saja
npm run deploy:cloudflare              # mengunggah folder public/ ke project "laporkka"
```

Situs tersedia di `https://laporkka.pages.dev`. Tambahkan origin-nya ke backend (pisahkan dengan koma):

```bash
supabase secrets set ALLOWED_ORIGINS=https://USERNAME.github.io,https://laporkka.pages.dev --project-ref <PROJECT_REF>
```

### Deploy otomatis dari GitHub

Workflow `.github/workflows/cloudflare-pages.yml` men-deploy `public/` ke Cloudflare Pages setiap push ke `main` yang mengubah `public/`. Tambahkan dua secret di GitHub (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — token dengan izin **Account → Cloudflare Pages → Edit**
- `CLOUDFLARE_ACCOUNT_ID` — ID akun Cloudflare

Domain kustom: `https://lapor.kkatelkomuniversity.com` (CNAME `lapor` → `laporkka.pages.dev`, proxied). Tambahkan origin-nya ke `ALLOWED_ORIGINS`.

## Pratinjau lokal

```sh
npm run serve:public
```

Buka `http://localhost:5173`. Tambahkan `http://localhost:5173` ke `ALLOWED_ORIGINS` jika ingin memanggil fungsi live dari sana.

## Peran

Admin dapat melihat seluruh laporan dan menugaskannya kepada akun aktif dengan peran `PKKM`, `PKM`, `ASUS`, `Akademik`, atau unit Kemahasiswaan. Petugas selain Admin hanya melihat laporan yang ditugaskan kepadanya.

## Batas pemrosesan AI

AI menerima kategori, tanggal/waktu kejadian, dan kronologi setelah nama pelapor/terlapor, NIM, email, dan nomor telepon dihapus atau disamarkan. Identitas terpisah, lokasi kejadian, dan file bukti tidak dikirim ke OpenAI. Hasilnya adalah rekomendasi untuk pratinjau Admin, bukan keputusan atau penetapan pelanggaran; Admin wajib memverifikasi pasal dan konteks.

## API (`/functions/v1/api`)

- `POST /reports` — menyimpan laporan dan bukti privat; mengembalikan token pelacakan sekali saja.
- `POST /reports/track` — status dan catatan tindak lanjut berdasarkan token.
- `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` — login username/password; sesi memakai token Bearer yang disimpan di `sessionStorage` tab.
- `GET /admin/reports`, `GET /admin/reports/:id`, `GET /admin/evidence/:id`
- `GET /admin/users`, `POST /admin/users` (Admin: membuat akun petugas selain Admin)
- `PATCH /admin/reports/:id/assignment` (Admin, body `{ "role": "PKM" }`; semua akun pada peran itu dapat melihat laporan), `PATCH /admin/reports/:id` (status dan catatan)

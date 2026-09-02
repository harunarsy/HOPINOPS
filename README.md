# HOPIN Stock Operations — demo lokal v0.3

Prototype React/Vite untuk MVP Stock Operations. Data awal bersumber dari spesifikasi v0.2, lalu diwujudkan sebagai workspace operasional Bar dan Kitchen—bukan document viewer. Flow lokal mencakup pemilihan shift/area, konfirmasi Opening, Perubahan stok, serta Closing untuk shift malam/full.

## Run

```bash
pnpm install
pnpm dev
```

Buka `http://localhost:3000`. `pnpm dev` hanya menjalankan UI Vite; endpoint login `/api/auth/*` berjalan saat project dijalankan oleh Vercel.

## Container

```bash
docker pull ghcr.io/harunarsy/hopinops:0.3.0
docker run --rm -p 8080:80 ghcr.io/harunarsy/hopinops:0.3.0
```

Lalu buka `http://localhost:8080`.

## Supabase foundation

Schema dan RLS policy ada di `supabase/migrations/`. Migration `0001`, `0002`, dan `0003` sudah diterapkan ke project HOPIN.

Setelah migration berhasil:

1. Tambahkan `VITE_SUPABASE_URL` dan `VITE_SUPABASE_PUBLISHABLE_KEY` di `.env.local` untuk asset browser.
2. Tambahkan `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` di Vercel sebagai server-only variables. Gunakan Secret untuk service role key.
3. Buat user dengan script provisioning. Script meminta PIN secara interaktif dan tidak menerima PIN sebagai argument:

   ```bash
   export SUPABASE_URL=https://your-project-ref.supabase.co
   export SUPABASE_SERVICE_ROLE_KEY='server-only-key'
   pnpm provision:user -- --username harun --display-name HARUN --job-title OWNER --role OWNER
   unset SUPABASE_SERVICE_ROLE_KEY
   ```

Gunakan hanya publishable/anon key di browser. Jangan masukkan `service_role` key ke variable berawalan `VITE_`, repository, atau chat.

Migration ini baru fondasi database. Auth sudah memakai API custom, sementara API command untuk assignment, opening, movement, dan closing masih belum diaktifkan.

## Prototype boundaries

Demo ini menyimpan item, assignment, opening, movement, closing, dan status laporan ke `localStorage`. Assignment shift dan area dikunci untuk tanggal berjalan setelah dikonfirmasi; Opening wajib dikonfirmasi sebelum Perubahan stok, sedangkan Closing hanya tersedia untuk shift malam/full. Input dapat pulih setelah refresh dan tetap dapat dipakai saat offline pada perangkat yang sama. Custom auth dan session sudah berjalan melalui API serverless, tetapi data operasional, single-session lease, lock assignment, dan timestamp workflow masih berasal dari browser lokal—belum merupakan audit server produksi. Sinkronisasi lintas perangkat, dashboard supervisor, PDF resmi, serta konflik multi-user tetap membutuhkan backend. Detail asumsi ada di `UX-CONTRACT.md`.

# HOPIN Stock Operations — demo lokal v0.3

Prototype React/Vite untuk MVP Stock Operations. Data awal bersumber dari spesifikasi v0.2, lalu diwujudkan sebagai workspace operasional Bar dan Kitchen—bukan document viewer. Flow lokal mencakup pemilihan shift/area, konfirmasi Opening, Perubahan stok, serta Closing untuk shift malam/full.

## Run

```bash
pnpm install
pnpm dev
```

Buka `http://localhost:3000`. Login demo memakai nama bebas dan PIN `1234`.

## Container

```bash
docker pull ghcr.io/harunarsy/hopinops:0.3.0
docker run --rm -p 8080:80 ghcr.io/harunarsy/hopinops:0.3.0
```

Lalu buka `http://localhost:8080`.

## Prototype boundaries

Demo ini menyimpan item, assignment, opening, movement, closing, dan status laporan ke `localStorage`. Assignment shift dan area dikunci untuk tanggal berjalan setelah dikonfirmasi; Opening wajib dikonfirmasi sebelum Perubahan stok, sedangkan Closing hanya tersedia untuk shift malam/full. Input dapat pulih setelah refresh dan tetap dapat dipakai saat offline pada perangkat yang sama. Login, single-session lease, lock assignment, dan timestamp masih berasal dari browser lokal—belum merupakan autentikasi atau audit server produksi. Sinkronisasi lintas perangkat, dashboard supervisor, PDF resmi, serta konflik multi-user tetap membutuhkan backend. Detail asumsi ada di `UX-CONTRACT.md`.

# HOPIN Stock Operations — demo lokal v0.3

Prototype React/Vite untuk MVP Stock Operations. Data awal bersumber dari spesifikasi v0.2, lalu diwujudkan sebagai workspace operasional Bar dan Kitchen—bukan document viewer.

## Run

```bash
pnpm install
pnpm dev
```

Buka `http://localhost:3000`. Login demo memakai nama bebas dan PIN `1234`.

## Prototype boundaries

Demo ini menyimpan item, movement, baseline closing, dan status submit ke `localStorage`. Input dapat pulih setelah refresh dan tetap dapat dipakai saat offline pada perangkat yang sama. Login, single-session lease, dan timestamp masih berasal dari browser lokal—belum merupakan autentikasi atau audit server produksi. Sinkronisasi lintas perangkat, PDF resmi, serta konflik multi-user tetap membutuhkan backend. Detail asumsi ada di `UX-CONTRACT.md`.

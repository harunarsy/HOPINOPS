---
version: alpha
colors:
  primary: "#123d32"
  primaryInteractive: "#1e5b48"
  surface: "#ffffff"
  canvas: "#f7f6f1"
  accent: "#c98732"
  success: "#3d8766"
  warning: "#c98732"
  danger: "#b95745"
typography:
  display:
    fontFamily: "Georgia, serif"
    fontSize: "3.5rem"
    lineHeight: "1.03"
  sans:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    lineHeight: "1.5"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.6875rem"
    lineHeight: "1.4"
rounded:
  card: "18px"
  control: "10px"
  pill: "999px"
spacing:
  unit: "4px"
components:
  app-shell:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.primary}"
  surface:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
  primary-button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    height: "44px"
    rounded: "{rounded.control}"
  primary-button-hover:
    backgroundColor: "{colors.primaryInteractive}"
  action-button:
    backgroundColor: "{colors.accent}"
  status-success:
    textColor: "{colors.success}"
    rounded: "{rounded.pill}"
  status-warning:
    textColor: "{colors.warning}"
    rounded: "{rounded.pill}"
  status-danger:
    textColor: "{colors.danger}"
    rounded: "{rounded.pill}"
---

## Overview

HOPIN Stock Operations adalah product surface untuk PIC Bar dan Kitchen yang dipakai sambil bekerja di cafe. Arah visualnya adalah **cafe ledger**: papan catatan operasional yang hangat, jelas, dan cukup berkarakter untuk terasa milik HOPIN. Ini bukan dashboard analitik dan bukan audit viewer.

Register-nya product/admin. Densitas default nyaman untuk layar sentuh; pada Closing, informasi ditata menjadi kartu yang tetap mudah dipindai pada 320–430px. Signature-nya adalah forest-green shell, paper canvas, typographic timestamps, dan aksen amber sebagai sinyal tindakan berikutnya.

## Colors

Forest green adalah warna kerja utama dan navigasi. Paper/cream menjaga permukaan tetap tenang saat staf mengisi angka. Amber hanya untuk perhatian yang dapat dipulihkan dan ajakan menyelesaikan closing. Merah hanya untuk stok habis/error operasional. Status tidak pernah disampaikan oleh warna saja: selalu ada label dan glyph.

Runtime mapping: token di atas dipetakan ke CSS variables di `src/index.css` (`--forest`, `--paper`, `--amber`, `--red`, `--green`) dan dipakai bersama seluruh surface.

## Typography

System sans dipakai untuk instruksi, label, dan teks yang harus cepat dibaca. Georgia dipakai terbatas pada aksen headline untuk memberi rasa editorial/cafe tanpa mengorbankan utilitas. System monospace memegang angka stok, waktu, satuan, dan metadata audit agar kolom mudah disejajarkan. Seluruh stack tersedia offline tanpa request font eksternal.

## Layout

Desktop memakai kanvas max 1250px dengan kolom utama + rail konteks. Smartphone beralih menjadi satu kolom, tab tetap horizontal-scrollable, dan submit bar menempel di bawah viewport agar aksi primer tidak hilang. Tidak ada horizontal scroll pada kartu stok.

## Elevation & Depth

Static surfaces menggunakan border hijau-pucat dan shadow rendah. Hero forest-green boleh memakai shadow lebih dalam karena menjadi orientasi shift. Modal adalah satu-satunya elevation tinggi. Scrollbar tetap terlihat dan menggunakan tema hijau-pucat global.

## Shapes

Kartu 18px, kontrol 10px, status chip/pill penuh. Bentuk lingkaran terbatas untuk avatar, progress ring, dan status glyph. Tidak ada glassmorphism atau gradient ungu.

## Components

- **Header**: identitas HOPIN, koneksi, jam WIB, dan avatar keluar.
- **Area switch**: satu canonical control untuk Bar/Kitchen; area aktif diberi check dan teks.
- **Metric**: angka + label + hint; tone tetap bermakna walaupun tanpa warna.
- **Stock row**: item, sisa sistem dari baseline, input fisik, status, variance.
- **Toast/live region**: satu status region di bawah untuk autosave, offline, dan submit.
- **Modal**: hanya untuk movement; native select dipakai karena popup platform acceptable untuk daftar pendek.

## Do's and Don'ts

- Do: tampilkan status save yang jujur sebagai local-only demo.
- Do: pertahankan unit dan angka tetap dekat dengan input.
- Do: tampilkan locked/submitted dengan copy eksplisit.
- Don't: menambahkan modul POS, absensi, pembayaran, atau security production.
- Don't: gunakan alert/confirm/prompt browser.
- Don't: membuat angka laporan tanpa sumber dari state lokal.

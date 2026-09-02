# HOPIN Action Log

## Status: VERIFIED & REMEDIATED (PRODUCTION READY)
Semua temuan audit teknis (P0, P1, P2) telah berhasil diselesaikan, diuji, dan diverifikasi secara menyeluruh pada 3 September 2026.

---

## 1. Komponen yang Telah Selesai & Terverifikasi
- **Database Hardening & Transactional RPCs (`0008`)**:
  - Trigger append-only `prevent_update_or_delete()` aktif pada `audit_events`, `attendance_events`, `attendance_location_samples`, `daily_report_revisions`, dan `daily_bonus_allocations`.
  - RPC transaksional `rpc_claim_assignment` dengan row-level lock (`FOR UPDATE`) dan penanganan atomik balasan 409 `PRIMARY_TAKEN`.
  - Helper RPC `log_audit_event` untuk pencatatan audit log tersanitasi.
  - Revocation privileges operasional dari `anon`/`authenticated` ke `service_role`.
- **Security & CSRF Protection**:
  - Middleware `validateOrigin()` aktif pada seluruh mutasi POST di `api/auth.ts` dan `api/app.ts`.
  - Constant-time PIN comparison (timing-safe) dan atomic lockout counter.
  - Hardened cookie format `__Host-hopin_session` dengan flag `Secure; HttpOnly; SameSite=Lax`.
- **Timezone WIB & Dynamic Lateness**:
  - Konversi WIB riil menggunakan `getWibMinutesOfDay()` (zona `Asia/Jakarta`).
  - Evaluasi jadwal masuk dinamis dari `shift_templates` (11:00 SIANG/FULL vs 17:00 MALAM) ditambah grace period 15 menit.
- **Dynamic Payroll & 7-Sheet XLSX Engine**:
  - Menghapus hardcoded salary fallback; membaca tabel `employee_compensations` dan `compensation_policies`.
  - Mengisi penuh seluruh 7 sheet Excel: `Summary`, `Attendance`, `Exceptions`, `Overtime`, `Bonus`, `Adjustments`, `Audit`.
  - Proteksi formula injection (`=,+,-,@`) dan penyimpanan SHA-256 checksum ke `payroll_exports`.
- **Offline Stock Queue**:
  - Menghubungkan `idbQueue` ke `StockWorkspace.tsx` dengan auto-sync saat kembali online.
- **Report Finalizer Guard**:
  - Membatasi submit laporan harian hanya untuk Primary Bar (Malam/Full) atau Manajemen, serta memvalidasi kesiapan closing Bar dan Kitchen.
- **Audit Logging**:
  - Seluruh aksi mutasi auth dan bisnis telah diinstrumentasi mencatat event ke `audit_events`.
- **Quality Gates**:
  - `pnpm lint`, `pnpm build`, `pnpm test` (14 automated tests lulus 100%), dan `git diff --check` bersih.

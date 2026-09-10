export type UserFacingErrorSurface = 'generic' | 'login';

type ErrorLike = {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  retryAfterSeconds?: unknown;
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const INTERNAL_DETAIL_PATTERN = /(?:API[_ -]?ERROR|HTTP\s*\d{3}|request[_ -]?id|PGRST|POSTGREST|SQLSTATE|SUPABASE|STACK\s*TRACE|TRACEBACK|\b(?:ECONN|ENOTFOUND|EAI_AGAIN|ERR_NETWORK)\b|\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b)/i;

function asErrorLike(error: unknown): ErrorLike {
  if (typeof error === 'object' && error !== null) return error as ErrorLike;
  return {};
}

function errorCode(error: unknown) {
  const code = asErrorLike(error).code;
  return typeof code === 'string' ? code.toUpperCase() : '';
}

function errorStatus(error: unknown) {
  const status = asErrorLike(error).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

function errorMessage(error: unknown) {
  if (typeof error === 'string') return error;
  const message = asErrorLike(error).message;
  return typeof message === 'string' ? message : '';
}

function isLocalOrigin() {
  if (typeof window === 'undefined') return false;
  return LOCAL_HOSTNAMES.has(window.location.hostname);
}

function isNetworkFailure(error: unknown) {
  const code = errorCode(error);
  return code === 'NETWORK_ERROR' || code === 'NON_JSON_RESPONSE' || code === 'INVALID_JSON_RESPONSE';
}

function isSafeMessage(message: string) {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 240 || /[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  return !INTERNAL_DETAIL_PATTERN.test(trimmed);
}

/**
 * Returns only copy that is appropriate for a person using the application.
 * Server logs may retain diagnostic context, but UI state must not expose it.
 */
export function getUserFacingError(
  error: unknown,
  fallback: string,
  options: { surface?: UserFacingErrorSurface } = {},
) {
  const surface = options.surface ?? 'generic';
  const code = errorCode(error);
  const status = errorStatus(error);
  const message = errorMessage(error);

  if (isLocalOrigin() && isNetworkFailure(error)) {
    return 'Server lokal belum terhubung. Jalankan pnpm dev:full, bukan pnpm dev, lalu buka ulang halaman.';
  }

  if (surface === 'login' && (status === 401 || code === 'AUTH_INVALID' || code === 'INVALID_CREDENTIALS')) {
    return 'Nama user atau PIN salah.';
  }

  if (code === 'AUTH_REQUIRED' || code === 'INVALID_SESSION' || code === 'INVALID_DEVICE' || status === 401) {
    return surface === 'login' ? 'Nama user atau PIN salah.' : 'Sesi berakhir. Silakan masuk lagi.';
  }

  if (code === 'ATTENDANCE_NOTE_REQUIRED') {
    return 'Catatan alasan wajib diisi jika lokasi GPS tidak terverifikasi.';
  }

  if (code === 'PRIMARY_TAKEN') {
    return 'Penanggung jawab utama area ini sudah terisi. Anda dapat bergabung sebagai Bantuan.';
  }

  if (code === 'MUTATION_TIMEOUT') {
    return 'Hasil transaksi belum terkonfirmasi karena batas waktu jaringan. Periksa status operasional sebelum mencoba kembali.';
  }

  if (code === 'REQUEST_TIMEOUT') {
    return 'Permintaan terlalu lama. Periksa koneksi lalu coba lagi.';
  }

  if (code === 'REQUEST_ABORTED') {
    return 'Permintaan dibatalkan.';
  }

  if (code === 'VERSION_CONFLICT' || code === 'STATE_CONFLICT' || status === 409) {
    return 'Data berubah atau status tidak lagi sesuai. Muat ulang sebelum melanjutkan.';
  }

  if (status === 403) return 'Tindakan ini tidak diizinkan.';
  if (status === 404) return 'Data tidak ditemukan.';
  if (status === 429) return 'Terlalu banyak percobaan. Silakan tunggu beberapa saat.';
  if (status !== null && status >= 500) return 'Server sedang bermasalah. Coba lagi.';

  if (code === 'RPC_UNAVAILABLE' || code === 'RPC_FAILED' || code === 'RPC_INVALID_RESPONSE') {
    return 'Server sedang bermasalah. Coba lagi.';
  }

  return isSafeMessage(message) ? message.trim() : fallback;
}

/**
 * Sanitizes a string already held by a component. This is useful as a final
 * render-time guard when a component receives an error prop from another
 * layer instead of the original Error object.
 */
export function sanitizeUserMessage(value: unknown, fallback: string) {
  const message = typeof value === 'string' ? value : '';
  return isSafeMessage(message) ? message.trim() : fallback;
}

export function getErrorCode(error: unknown) {
  return errorCode(error);
}

export function getErrorMessage(error: unknown) {
  return errorMessage(error);
}

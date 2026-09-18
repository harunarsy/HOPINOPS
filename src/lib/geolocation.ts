export type GpsSample = {
  latitude: number;
  longitude: number;
  accuracy_m: number;
  client_sampled_at: string;
};

export type LocationFailure = 'DENIED' | 'TIMEOUT' | 'UNAVAILABLE';

export type LocationIssue = LocationFailure | 'INSECURE' | 'IN_APP_BROWSER';

export type LocationResult = {
  samples: GpsSample[];
  failure?: LocationFailure;
  issue?: LocationIssue;
};

export type GpsSettings = {
  maxAccuracyM: number;
  sampleLimit: number;
  timeoutSeconds: number;
};

export type GpsSettingsInput = {
  max_accuracy_m?: number | null;
  gps_sample_limit?: number | null;
  gps_timeout_seconds?: number | null;
} | null;

export const DEFAULT_GPS_SETTINGS: GpsSettings = {
  maxAccuracyM: 50,
  sampleLimit: 3,
  timeoutSeconds: 15,
};

const MAX_BUFFERED_SAMPLES = 8;

export const LOCATION_ISSUE_MESSAGES: Record<LocationIssue, string> = {
  DENIED: 'Izin lokasi ditolak. Buka ikon kunci di address bar → izinkan Lokasi, lalu tekan Coba Lagi.',
  IN_APP_BROWSER: 'Aplikasi ini terbuka dari dalam aplikasi lain (WhatsApp/Instagram). Buka di Chrome atau Safari agar popup izin lokasi muncul.',
  INSECURE: 'Popup izin lokasi hanya muncul di koneksi aman (https). Buka alamat aplikasi versi https.',
  TIMEOUT: 'GPS belum dapat sinyal. Nyalakan Lokasi/GPS di perangkat, lalu tekan Coba Lagi.',
  UNAVAILABLE: 'GPS belum aktif. Nyalakan Lokasi/GPS di perangkat (bukan hanya izin browser), lalu tekan Coba Lagi.',
};

export function normalizeGpsSettings(raw?: GpsSettingsInput): GpsSettings {
  const maxAccuracyM = Number(raw?.max_accuracy_m);
  const sampleLimit = Number(raw?.gps_sample_limit);
  const timeoutSeconds = Number(raw?.gps_timeout_seconds);
  return {
    maxAccuracyM: Number.isFinite(maxAccuracyM) && maxAccuracyM >= 5 && maxAccuracyM <= 500
      ? maxAccuracyM
      : DEFAULT_GPS_SETTINGS.maxAccuracyM,
    sampleLimit: Number.isInteger(sampleLimit) && sampleLimit >= 1 && sampleLimit <= 10
      ? sampleLimit
      : DEFAULT_GPS_SETTINGS.sampleLimit,
    timeoutSeconds: Number.isInteger(timeoutSeconds) && timeoutSeconds >= 5 && timeoutSeconds <= 60
      ? timeoutSeconds
      : DEFAULT_GPS_SETTINGS.timeoutSeconds,
  };
}

export function detectInAppBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/Android/i.test(ua) && (/(^|;\s)wv\)/.test(ua) || /\bwv\b/i.test(ua))) return true;
  if (/FBAN|FBAV|Instagram|Line\/|WhatsApp|Twitter/i.test(ua)) return true;
  // iOS in-app browser (WKWebView) tidak memuat token Safari; Safari/Chrome iOS (CriOS) memuatnya.
  if (/iPhone|iPad|iPod/i.test(ua) && !/Safari|CriOS|FxiOS|EdgiOS/i.test(ua)) return true;
  return false;
}

export function geolocationSupportIssue(): LocationIssue | null {
  if (typeof window === 'undefined') return 'UNAVAILABLE';
  // Popup izin lokasi tidak mungkin muncul di kondisi ini — beri pesan yang
  // bisa ditindaklanjuti alih-alih menunggu timeout tanpa penjelasan.
  if (!window.isSecureContext) return 'INSECURE';
  if (!navigator.geolocation) return 'UNAVAILABLE';
  if (detectInAppBrowser()) return 'IN_APP_BROWSER';
  return null;
}

export async function queryGeolocationPermission(): Promise<'granted' | 'prompt' | 'denied' | 'unknown'> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state;
  } catch {
    return 'unknown';
  }
}

export function gpsGuideSteps(): string[] {
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) {
      return [
        'Buka Setelan → Lokasi → aktifkan "Gunakan lokasi".',
        'Ketuk ikon kunci di address bar → Izin → Lokasi → Izinkan.',
        'Matikan mode hemat baterai bila GPS tidak mau mengunci.',
      ];
    }
    if (/iPhone|iPad|iPod/i.test(ua)) {
      return [
        'Buka Setelan → Privasi & Keamanan → Layanan Lokasi → aktifkan.',
        'Setelan → Safari (atau Chrome) → Lokasi → "Saat Menggunakan App".',
        'Aktifkan "Lokasi Tepat" agar akurasi di bawah 50 meter.',
      ];
    }
  }
  return [
    'Windows: Setelan → Privasi & keamanan → Lokasi → aktifkan.',
    'macOS: System Settings → Privacy & Security → Location Services → aktifkan untuk browser.',
    'Chrome: ketuk ikon kunci di address bar → Izin lokasi → Izinkan, lalu muat ulang halaman.',
  ];
}

export type GpsWatchEvent = {
  sample?: GpsSample;
  issue?: LocationIssue;
};

export type GpsWatch = {
  stop: () => void;
  latest: (maxAgeMs: number) => GpsSample | null;
  bestAccuracyM: () => number | null;
  lastIssue: () => LocationIssue | null;
  subscribe: (listener: (event: GpsWatchEvent) => void) => () => void;
  waitForSamples: (settings: GpsSettings) => Promise<LocationResult>;
};

type WatchHandlers = {
  onSample?: (sample: GpsSample) => void;
  onIssue?: (issue: LocationIssue) => void;
};

function toSample(position: GeolocationPosition): GpsSample {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy_m: Math.round(position.coords.accuracy),
    client_sampled_at: new Date(position.timestamp).toISOString(),
  };
}

function mapErrorCode(code: number): LocationIssue {
  if (code === 1) return 'DENIED';
  if (code === 3) return 'TIMEOUT';
  return 'UNAVAILABLE';
}

/**
 * Satu watch GPS yang hidup selama layar absensi terbuka. Ini yang membuat
 * perangkat benar-benar mengaktifkan receiver lebih awal (prompt izin muncul
 * saat layar dibuka, bukan saat geser) sehingga sampel siap dipakai.
 */
export function startGpsWatch(handlers: WatchHandlers = {}): GpsWatch | null {
  if (geolocationSupportIssue()) return null;

  const buffer: Array<{ sample: GpsSample; at: number }> = [];
  const listeners = new Set<(event: GpsWatchEvent) => void>();
  let lastIssue: LocationIssue | null = null;
  let stopped = false;

  const emit = (event: GpsWatchEvent) => {
    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch {
        // Listener gagal tidak boleh mematikan watch GPS.
      }
    });
  };

  let watchId: number | undefined;
  try {
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        if (stopped) return;
        const sample = toSample(position);
        buffer.push({ sample, at: Date.now() });
        if (buffer.length > MAX_BUFFERED_SAMPLES) buffer.shift();
        lastIssue = null;
        handlers.onSample?.(sample);
        emit({ sample });
      },
      (error) => {
        if (stopped) return;
        const issue = mapErrorCode(error.code);
        // DENIED permanen; UNAVAILABLE/TIMEOUT bisa pulih, jadi watch tetap hidup.
        if (issue === 'DENIED') lastIssue = 'DENIED';
        else if (lastIssue !== 'DENIED') lastIssue = issue;
        handlers.onIssue?.(issue);
        emit({ issue });
      },
      { enableHighAccuracy: true, maximumAge: 0 },
    );
  } catch {
    return null;
  }

  const latest = (maxAgeMs: number): GpsSample | null => {
    const now = Date.now();
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      const entry = buffer[index];
      if (now - entry.at <= maxAgeMs) return entry.sample;
    }
    return null;
  };

  const bestAccuracyM = (): number | null => {
    if (buffer.length === 0) return null;
    return buffer.reduce((min, entry) => Math.min(min, entry.sample.accuracy_m), Infinity);
  };

  const subscribe = (listener: (event: GpsWatchEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const waitForSamples = (settings: GpsSettings): Promise<LocationResult> => {
    const timeoutMs = settings.timeoutSeconds * 1000;
    // Sampel dari watch yang masih hidup dianggap segar; di luar itu tunggu fix baru.
    const seedMaxAgeMs = Math.min(Math.max(timeoutMs, 5_000), 15_000);

    return new Promise<LocationResult>((resolve) => {
      const samples: GpsSample[] = [];
      let settled = false;
      let issue: LocationIssue | null = lastIssue;
      let unsubscribe: () => void = () => {};
      let deadlineId: number | undefined;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (deadlineId !== undefined) window.clearTimeout(deadlineId);
        unsubscribe();
        if (samples.length > 0) {
          resolve({ samples: samples.slice(0, settings.sampleLimit) });
          return;
        }
        const failure: LocationFailure = issue === 'DENIED'
          ? 'DENIED'
          : issue === 'TIMEOUT'
            ? 'TIMEOUT'
            : 'UNAVAILABLE';
        resolve({ samples: [], failure, issue: issue ?? 'TIMEOUT' });
      };

      const bestAccuracy = () => samples.reduce((min, sample) => Math.min(min, sample.accuracy_m), Infinity);

      const evaluate = () => {
        if (samples.length === 0) return;
        // Keluar lebih awal begitu ada satu fix yang layak: ini yang menghapus
        // timeout 10 detik menunggu 3 sampel walau 1 sampel sudah sah di server.
        if (bestAccuracy() <= settings.maxAccuracyM) {
          finish();
          return;
        }
        if (samples.length >= settings.sampleLimit) finish();
      };

      const push = (sample: GpsSample) => {
        if (samples.some((existing) => existing.client_sampled_at === sample.client_sampled_at)) return;
        samples.push(sample);
      };

      const seed = latest(seedMaxAgeMs);
      if (seed) {
        push(seed);
        evaluate();
        if (settled) return;
      }

      unsubscribe = subscribe((event) => {
        if (settled) return;
        if (event.sample) {
          push(event.sample);
          evaluate();
          return;
        }
        if (event.issue === 'DENIED') {
          issue = 'DENIED';
          finish();
          return;
        }
        if (event.issue) issue = event.issue;
      });

      deadlineId = window.setTimeout(() => {
        if (!issue) issue = 'TIMEOUT';
        finish();
      }, timeoutMs);
    });
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
    listeners.clear();
  };

  return { stop, latest, bestAccuracyM, lastIssue: () => lastIssue, subscribe, waitForSamples };
}

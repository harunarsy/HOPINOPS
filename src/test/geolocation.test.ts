import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GPS_SETTINGS,
  geolocationSupportIssue,
  normalizeGpsSettings,
  startGpsWatch,
  type GpsSample,
} from '../lib/geolocation';

type PositionHandlers = {
  success: PositionCallback;
  error: PositionErrorCallback;
  options?: PositionOptions;
};

const position = (accuracy: number, timestamp: number) => ({
  coords: { latitude: -6.2, longitude: 106.8, accuracy } as GeolocationCoordinates,
  timestamp,
}) as GeolocationPosition;

describe('geolocation', () => {
  let handlers: PositionHandlers[];
  let clearWatch: ReturnType<typeof vi.fn>;
  let watchPosition: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers = [];
    clearWatch = vi.fn();
    watchPosition = vi.fn((success: PositionCallback, error: PositionErrorCallback, options?: PositionOptions) => {
      handlers.push({ success, error, options });
      return handlers.length;
    });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'geolocation', {
      value: { watchPosition, clearWatch },
      configurable: true,
    });
    Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('memakai default outlet saat pengaturan tidak lengkap', () => {
    expect(normalizeGpsSettings(null)).toEqual(DEFAULT_GPS_SETTINGS);
    expect(normalizeGpsSettings({ max_accuracy_m: 5, gps_sample_limit: 20, gps_timeout_seconds: 0 }))
      .toEqual({ maxAccuracyM: 5, sampleLimit: DEFAULT_GPS_SETTINGS.sampleLimit, timeoutSeconds: DEFAULT_GPS_SETTINGS.timeoutSeconds });
    expect(normalizeGpsSettings({ max_accuracy_m: 80, gps_sample_limit: 2, gps_timeout_seconds: 30 }))
      .toEqual({ maxAccuracyM: 80, sampleLimit: 2, timeoutSeconds: 30 });
  });

  it('menyatakan dukungan GPS lewat preflight tanpa menunggu timeout', () => {
    expect(geolocationSupportIssue()).toBeNull();
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    expect(geolocationSupportIssue()).toBe('INSECURE');
  });

  it('selesai lebih awal begitu ada satu sampel yang layak', async () => {
    const watch = startGpsWatch();
    expect(watch).not.toBeNull();
    expect(watchPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: true,
      maximumAge: 0,
    });

    const pending = watch!.waitForSamples({ maxAccuracyM: 50, sampleLimit: 3, timeoutSeconds: 15 });
    handlers[0].success(position(12, Date.now()));

    const result = await pending;
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].accuracy_m).toBe(12);
    expect(result.failure).toBeUndefined();
    watch!.stop();
    expect(clearWatch).toHaveBeenCalled();
  });

  it('memakai sampel watch yang masih segar tanpa menunggu fix baru', async () => {
    const watch = startGpsWatch();
    handlers[0].success(position(20, Date.now()));

    const result = await watch!.waitForSamples({ maxAccuracyM: 50, sampleLimit: 3, timeoutSeconds: 15 });
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].accuracy_m).toBe(20);
    watch!.stop();
  });

  it('mengumpulkan beberapa sampel saat akurasi masih kasar', async () => {
    const watch = startGpsWatch();
    const pending = watch!.waitForSamples({ maxAccuracyM: 50, sampleLimit: 2, timeoutSeconds: 15 });
    handlers[0].success(position(200, Date.now()));
    handlers[0].success(position(180, Date.now() + 1));

    const result = await pending;
    expect(result.samples.map((sample: GpsSample) => sample.accuracy_m)).toEqual([200, 180]);
    watch!.stop();
  });

  it('mengembalikan DENIED segera saat izin ditolak', async () => {
    const watch = startGpsWatch();
    const pending = watch!.waitForSamples({ maxAccuracyM: 50, sampleLimit: 3, timeoutSeconds: 15 });
    handlers[0].error({ code: 1, message: 'denied' } as GeolocationPositionError);

    const result = await pending;
    expect(result.samples).toHaveLength(0);
    expect(result.failure).toBe('DENIED');
    expect(result.issue).toBe('DENIED');
    watch!.stop();
  });

  it('menunggu sampai batas waktu outlet lalu melaporkan TIMEOUT', async () => {
    vi.useFakeTimers();
    const watch = startGpsWatch();
    const pending = watch!.waitForSamples({ maxAccuracyM: 50, sampleLimit: 3, timeoutSeconds: 7 });
    handlers[0].error({ code: 2, message: 'no provider' } as GeolocationPositionError);

    await vi.advanceTimersByTimeAsync(7_000);
    const result = await pending;
    expect(result.samples).toHaveLength(0);
    expect(result.failure).toBe('UNAVAILABLE');
    expect(result.issue).toBe('UNAVAILABLE');
    watch!.stop();
  });

  it('memberi tahu status izin ditolak lewat onIssue', () => {
    const onIssue = vi.fn();
    const watch = startGpsWatch({ onIssue });
    handlers[0].error({ code: 1, message: 'denied' } as GeolocationPositionError);
    expect(onIssue).toHaveBeenCalledWith('DENIED');
    expect(watch!.lastIssue()).toBe('DENIED');
    watch!.stop();
  });
});

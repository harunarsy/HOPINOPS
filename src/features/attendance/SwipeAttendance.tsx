import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { getErrorCode, getErrorMessage, getUserFacingError } from '../../lib/user-facing-error';
import {
  LOCATION_ISSUE_MESSAGES,
  geolocationSupportIssue,
  gpsGuideSteps,
  normalizeGpsSettings,
  queryGeolocationPermission,
  startGpsWatch,
  type GpsSettingsInput,
  type GpsWatch,
  type LocationIssue,
  type LocationResult,
} from '../../lib/geolocation';

type Props = {
  actionType: 'CHECK_IN' | 'CHECK_OUT';
  assignmentId?: string;
  gps?: GpsSettingsInput;
  onSuccess: () => void;
  onCancel?: () => void;
  onRecoverableConflict?: (code: string) => void;
};

type GpsUiState = 'WARMING' | 'READY' | 'DENIED' | 'BLOCKED' | 'UNSUPPORTED';

export function SwipeAttendance({ actionType, assignmentId, gps, onSuccess, onCancel, onRecoverableConflict }: Props) {
  const [sliderPos, setSliderPos] = useState(0);
  const [status, setStatus] = useState<'IDLE' | 'LOCATING' | 'VERIFYING' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [errorMessage, setErrorMessage] = useState('');
  const [note, setNote] = useState('');
  const [needsNote, setNeedsNote] = useState(false);
  const [gpsState, setGpsState] = useState<GpsUiState>('WARMING');
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [bypassGps, setBypassGps] = useState(false);
  const locationRef = useRef<LocationResult | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const watchRef = useRef<GpsWatch | null>(null);
  const supportIssueRef = useRef<LocationIssue | null>(null);

  const isCheckIn = actionType === 'CHECK_IN';
  const gpsSettings = useMemo(() => normalizeGpsSettings(gps), [gps]);
  const gpsSettingsRef = useRef(gpsSettings);
  gpsSettingsRef.current = gpsSettings;

  // Watch hidup sejak layar dibuka: prompt izin muncul lebih awal dan receiver
  // GPS sudah terkunci saat karyawan menggeser, bukan baru mulai dari nol.
  const startWatch = () => {
    supportIssueRef.current = geolocationSupportIssue();
    if (supportIssueRef.current) {
      setGpsState(supportIssueRef.current === 'DENIED' ? 'DENIED' : 'UNSUPPORTED');
      return;
    }
    setGpsState('WARMING');
    setGpsAccuracy(null);
    const watch = startGpsWatch({
      onSample: (sample) => {
        setGpsAccuracy(sample.accuracy_m);
        setGpsState('READY');
      },
      onIssue: (issue) => {
        setGpsState(issue === 'DENIED' ? 'DENIED' : 'BLOCKED');
      },
    });
    watchRef.current = watch;
    if (!watch) {
      setGpsState('UNSUPPORTED');
      return;
    }
    void queryGeolocationPermission().then((permission) => {
      if (permission === 'denied') setGpsState('DENIED');
    });
  };

  useEffect(() => {
    startWatch();
    return () => {
      watchRef.current?.stop();
      watchRef.current = null;
    };
  }, []);

  const retryGps = () => {
    watchRef.current?.stop();
    watchRef.current = null;
    locationRef.current = null;
    setBypassGps(false);
    setErrorMessage('');
    startWatch();
  };

  const collectGpsSamples = async (): Promise<LocationResult> => {
    const supportIssue = supportIssueRef.current;
    if (supportIssue) return { samples: [], failure: 'UNAVAILABLE', issue: supportIssue };
    const watch = watchRef.current;
    if (!watch) return { samples: [], failure: 'UNAVAILABLE', issue: 'UNAVAILABLE' };
    return watch.waitForSamples(gpsSettingsRef.current);
  };

  const gpsUnavailable = gpsState === 'DENIED' || gpsState === 'BLOCKED' || gpsState === 'UNSUPPORTED';
  const gpsBlocked = gpsUnavailable && !bypassGps && status === 'IDLE' && !needsNote;
  const gpsIssue: LocationIssue = supportIssueRef.current
    ?? (gpsState === 'DENIED' ? 'DENIED' : 'UNAVAILABLE');
  const gpsStatusText = gpsState === 'READY'
    ? `GPS aktif${gpsAccuracy !== null ? ` · akurasi ±${gpsAccuracy} m` : ''}`
    : gpsState === 'WARMING'
      ? 'Menyalakan GPS… izinkan akses lokasi bila popup muncul'
      : gpsState === 'DENIED'
        ? 'Izin lokasi ditolak'
        : gpsState === 'UNSUPPORTED'
          ? LOCATION_ISSUE_MESSAGES[supportIssueRef.current ?? 'UNAVAILABLE']
          : 'GPS belum aktif di perangkat';

  const performAttendance = async (providedNote?: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    idempotencyKeyRef.current ??= crypto.randomUUID();
    setStatus('LOCATING');
    setErrorMessage('');

    try {
      if (!locationRef.current) {
        locationRef.current = await collectGpsSamples();
      }

      const location = locationRef.current;
      const submittedNote = providedNote ?? note;
      if (location.samples.length === 0 && !submittedNote.trim()) {
        setNeedsNote(true);
        setStatus('IDLE');
        setSliderPos(0);
        setErrorMessage(`${LOCATION_ISSUE_MESSAGES[location.issue ?? 'UNAVAILABLE']} Catatan alasan wajib diisi.`);
        return;
      }

      setStatus('VERIFYING');

      const { challengeId } = await api.requestChallenge(actionType);
      const payload = {
        challengeId,
        samples: location.samples,
        note: submittedNote,
        idempotencyKey: idempotencyKeyRef.current,
        locationFailure: location.failure,
        assignmentId,
      };

      if (isCheckIn) {
        await api.checkIn(payload);
      } else {
        await api.checkOut(payload);
      }

      idempotencyKeyRef.current = null;
      setStatus('SUCCESS');
      setTimeout(onSuccess, 1000);
    } catch (err: any) {
      console.error(err);
      const code = getErrorCode(err);
      const recoverableCheckoutConflict = !isCheckIn
        && (code === 'CHECK_IN_REQUIRED' || code === 'ALREADY_CHECKED_OUT' || code === 'NO_OPEN_ATTENDANCE');
      if (recoverableCheckoutConflict) {
        setStatus('IDLE');
        setSliderPos(0);
        setErrorMessage('');
        onRecoverableConflict?.(code);
        return;
      }
      if (code === 'ATTENDANCE_NOTE_REQUIRED' || getErrorMessage(err).includes('Catatan alasan wajib diisi')) {
        setNeedsNote(true);
        setStatus('IDLE');
        setSliderPos(0);
        setErrorMessage('Lokasi GPS berada di luar cafe atau akurasi rendah. Harap masukkan catatan alasan absensi.');
      } else {
        setStatus('ERROR');
        setSliderPos(0);
        setErrorMessage(getUserFacingError(err, 'Gagal melakukan absensi.'));
      }
    } finally {
      inFlightRef.current = false;
    }
  };

  const cancelAttempt = () => {
    locationRef.current = null;
    idempotencyKeyRef.current = null;
    setSliderPos(0);
    setStatus('IDLE');
    setNeedsNote(false);
    setErrorMessage('');
    onCancel?.();
  };

  const [isDragging, setIsDragging] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  const startDrag = (clientX: number) => {
    if (status !== 'IDLE' || needsNote || gpsBlocked) return;
    setIsDragging(true);
    updateDragPosition(clientX);
  };

  const updateDragPosition = (clientX: number) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const width = rect.width - 52; // subtract knob width
    const offsetX = Math.max(0, Math.min(clientX - rect.left - 26, width));
    const percent = Math.round((offsetX / width) * 100);
    setSliderPos(percent);
    if (percent >= 90 && !inFlightRef.current && status === 'IDLE' && !gpsBlocked) {
      setIsDragging(false);
      setSliderPos(100);
      void performAttendance();
    }
  };

  const stopDrag = () => {
    if (!isDragging) return;
    setIsDragging(false);
    if (sliderPos < 90) {
      setSliderPos(0);
    }
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setSliderPos(val);
    if (val >= 90 && status === 'IDLE' && !inFlightRef.current && !gpsBlocked) {
      void performAttendance();
    }
  };

  return (
    <div className="section-card" style={{ maxWidth: '440px', margin: '20px auto', padding: '24px' }}>
      <div style={{ textAlign: 'center', marginBottom: '20px' }}>
        <p className="eyebrow">{isCheckIn ? 'ABSENSI MASUK SHIFT' : 'ABSENSI PULANG / SELESAI'}</p>
        <h2>{isCheckIn ? 'Verifikasi Kehadiran' : 'Selesai Bertugas'}</h2>
        <p className="muted" style={{ fontSize: '13px' }}>
          {isCheckIn
            ? 'Geser ke kanan untuk check-in. GPS akan mengukur lokasi Anda.'
            : 'Geser ke kanan untuk check-out dan mengakhiri jam kerja.'}
        </p>
      </div>

      {status === 'IDLE' && !needsNote && (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            padding: '8px 12px',
            borderRadius: '10px',
            fontSize: '12px',
            fontWeight: 600,
            textAlign: 'center',
            background: gpsState === 'READY' ? '#e5f2ea' : gpsState === 'WARMING' ? '#fdf3dd' : '#fde8e8',
            color: gpsState === 'READY' ? '#1e5b48' : gpsState === 'WARMING' ? '#92600a' : '#a12424',
          }}
        >
          <span aria-hidden="true">{gpsState === 'READY' ? '✓' : gpsState === 'WARMING' ? '…' : '!'}</span>
          <span>{gpsStatusText}</span>
        </div>
      )}

      {status === 'LOCATING' && (
        <div role="status" aria-live="polite" style={{ textAlign: 'center', padding: '20px' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />
          <strong>Mengukur Koordinat GPS...</strong>
          <p className="muted" style={{ fontSize: '12px' }}>Mengambil sample akurasi tinggi</p>
        </div>
      )}

      {status === 'VERIFYING' && (
        <div role="status" aria-live="polite" style={{ textAlign: 'center', padding: '20px' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />
          <strong>Memverifikasi ke Server...</strong>
        </div>
      )}

      {status === 'SUCCESS' && (
        <div role="status" aria-live="polite" style={{ textAlign: 'center', padding: '20px', color: '#1e5b48' }}>
          <span style={{ fontSize: '32px' }}>✓</span>
          <br />
          <strong>Absensi Berhasil Tercatat!</strong>
        </div>
      )}

      {needsNote && status === 'IDLE' && (
        <div style={{ marginBottom: '16px' }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: '#d97706', display: 'block', marginBottom: '6px' }}>
            Catatan Alasan Lokasi (Wajib):
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Contoh: GPS di dalam ruangan lambat lock, saya sudah berada di Bar."
            rows={3}
            style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid #cddcd4' }}
          />
          <button
            type="button"
            className="primary-button"
            style={{ width: '100%', marginTop: '10px' }}
            disabled={!note.trim()}
            onClick={() => void performAttendance(note)}
          >
            Kirim Absensi dengan Catatan →
          </button>
        </div>
      )}

      {errorMessage && (
        <p role="alert" className="form-error" style={{ marginBottom: '16px' }}>{errorMessage}</p>
      )}

      {status === 'ERROR' && (
        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            type="button"
            className="primary-button"
            style={{ flex: 1 }}
            onClick={() => {
              // Coba ulang harus meminta GPS lagi (mis. setelah izin diaktifkan).
              locationRef.current = null;
              void performAttendance();
            }}
          >
            Coba Lagi
          </button>
          <button type="button" className="outline-button" style={{ flex: 1 }} onClick={cancelAttempt}>
            Batal
          </button>
        </div>
      )}

      {gpsBlocked && (
        <div style={{ marginTop: '14px', padding: '14px', borderRadius: '12px', background: '#fdecec', border: '1px solid #f3c9c9' }}>
          <strong style={{ fontSize: '13px', color: '#a12424', display: 'block', marginBottom: '6px' }}>
            Absensi dikunci sampai GPS aktif
          </strong>
          <p className="muted" style={{ fontSize: '12px', marginBottom: '10px' }}>
            {LOCATION_ISSUE_MESSAGES[gpsIssue]}
          </p>
          <details style={{ fontSize: '12px', marginBottom: '10px' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Cara mengaktifkan GPS di perangkat ini</summary>
            <ol style={{ margin: '8px 0 0 18px', padding: 0, lineHeight: 1.6 }}>
              {gpsGuideSteps().map((step) => <li key={step}>{step}</li>)}
            </ol>
          </details>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="primary-button" style={{ flex: 1 }} onClick={retryGps}>
              Coba Lagi
            </button>
            <button type="button" className="outline-button" style={{ flex: 1 }} onClick={() => setBypassGps(true)}>
              Absen tanpa GPS
            </button>
          </div>
        </div>
      )}

      {status === 'IDLE' && !needsNote && !gpsBlocked && (
        <div
          ref={trackRef}
          style={{
            position: 'relative',
            marginTop: '16px',
            height: '56px',
            borderRadius: '28px',
            background: '#e0ece6',
            overflow: 'hidden',
            userSelect: 'none',
            touchAction: 'none',
          }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            startDrag(e.clientX);
          }}
          onPointerMove={(e) => {
            if (isDragging) updateDragPosition(e.clientX);
          }}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
        >
          {/* Progress fill */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              bottom: 0,
              width: `${Math.max(sliderPos, 14)}%`,
              background: '#1e5b48',
              opacity: 0.25,
              borderRadius: '28px',
              transition: isDragging ? 'none' : 'width 0.25s ease-out',
            }}
          />

          {/* Track Text */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#1e5b48',
              fontWeight: 700,
              fontSize: '14px',
              letterSpacing: '0.04em',
              pointerEvents: 'none',
              opacity: Math.max(0, 1 - sliderPos / 60),
              transition: 'opacity 0.15s ease',
            }}
          >
            Geser untuk Absen ➔
          </div>

          {/* Draggable Knob */}
          <div
            style={{
              position: 'absolute',
              top: '4px',
              left: `calc(${sliderPos}% * (1 - 48px / 100%) + 4px)`,
              width: '48px',
              height: '48px',
              borderRadius: '24px',
              background: '#fff',
              boxShadow: '0 4px 14px rgba(18, 61, 50, 0.28)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#1e5b48',
              fontSize: '18px',
              fontWeight: 900,
              cursor: 'grab',
              transition: isDragging ? 'none' : 'left 0.25s ease-out',
            }}
          >
            ➔
          </div>

          {/* Hidden range input for keyboard / screen reader accessibility */}
          <input
            type="range"
            min={0}
            max={100}
            value={sliderPos}
            onChange={handleSliderChange}
            aria-label={isCheckIn ? 'Geser untuk Check-In' : 'Geser untuk Check-Out'}
            style={{
              position: 'absolute',
              inset: 0,
              opacity: 0,
              pointerEvents: 'none',
            }}
          />
        </div>
      )}

      {onCancel && status === 'IDLE' && (
        <button
          type="button"
          className="outline-button"
          onClick={cancelAttempt}
          style={{ width: '100%', marginTop: '12px' }}
        >
          Batal / Kembali
        </button>
      )}
    </div>
  );
}

import { useState, useRef } from 'react';
import { api } from '../../lib/api';

type Props = {
  actionType: 'CHECK_IN' | 'CHECK_OUT';
  assignmentId?: string;
  onSuccess: () => void;
  onCancel?: () => void;
};

type GpsSample = {
  latitude: number;
  longitude: number;
  accuracy_m: number;
  client_sampled_at: string;
};

type LocationFailure = 'DENIED' | 'TIMEOUT' | 'UNAVAILABLE';

type LocationResult = {
  samples: GpsSample[];
  failure?: LocationFailure;
};

export function SwipeAttendance({ actionType, assignmentId, onSuccess, onCancel }: Props) {
  const [sliderPos, setSliderPos] = useState(0);
  const [status, setStatus] = useState<'IDLE' | 'LOCATING' | 'VERIFYING' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [errorMessage, setErrorMessage] = useState('');
  const [note, setNote] = useState('');
  const [needsNote, setNeedsNote] = useState(false);
  const locationRef = useRef<LocationResult | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const isCheckIn = actionType === 'CHECK_IN';

  const collectGpsSamples = async (): Promise<LocationResult> => {
    if (!navigator.geolocation) {
      return { samples: [], failure: 'UNAVAILABLE' };
    }

    return new Promise((resolve) => {
      const samples: GpsSample[] = [];
      let settled = false;
      let watchId: number | undefined;

      const finish = (failure?: LocationFailure) => {
        if (settled) return;
        settled = true;
        if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
        clearTimeout(timeoutId);
        resolve({ samples, failure: samples.length === 0 ? failure ?? 'UNAVAILABLE' : undefined });
      };

      const timeoutId = window.setTimeout(() => finish('TIMEOUT'), 10000);

      try {
        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            if (samples.length >= 3) return;
            samples.push({
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy_m: Math.round(pos.coords.accuracy),
              client_sampled_at: new Date(pos.timestamp).toISOString(),
            });
            if (samples.length === 3) finish();
          },
          (error) => {
            const failure: LocationFailure = error.code === 1
              ? 'DENIED'
              : error.code === 3
                ? 'TIMEOUT'
                : 'UNAVAILABLE';
            finish(failure);
          },
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
      } catch {
        finish('UNAVAILABLE');
      }
    });
  };

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
        setErrorMessage('Lokasi GPS tidak tersedia. Catatan alasan wajib diisi.');
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
      if (err.message && err.message.includes('Catatan alasan wajib diisi')) {
        setNeedsNote(true);
        setStatus('IDLE');
        setSliderPos(0);
        setErrorMessage('Lokasi GPS berada di luar cafe atau akurasi rendah. Harap masukkan catatan alasan absensi.');
      } else {
        setStatus('ERROR');
        setSliderPos(0);
        setErrorMessage(err.message || 'Gagal melakukan absensi.');
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
    if (status !== 'IDLE' || needsNote) return;
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
    if (percent >= 90 && !inFlightRef.current && status === 'IDLE') {
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
    if (val >= 90 && status === 'IDLE' && !inFlightRef.current) {
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
          <button type="button" className="primary-button" style={{ flex: 1 }} onClick={() => void performAttendance()}>
            Coba Lagi
          </button>
          <button type="button" className="outline-button" style={{ flex: 1 }} onClick={cancelAttempt}>
            Batal
          </button>
        </div>
      )}

      {status === 'IDLE' && !needsNote && (
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

import { useState, useRef } from 'react';
import { api } from '../../lib/api';

type Props = {
  actionType: 'CHECK_IN' | 'CHECK_OUT';
  assignmentId?: string;
  onSuccess: () => void;
  onCancel?: () => void;
};

export function SwipeAttendance({ actionType, assignmentId, onSuccess, onCancel }: Props) {
  const [sliderPos, setSliderPos] = useState(0);
  const [status, setStatus] = useState<'IDLE' | 'LOCATING' | 'VERIFYING' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [errorMessage, setErrorMessage] = useState('');
  const [note, setNote] = useState('');
  const [needsNote, setNeedsNote] = useState(false);
  const [cachedSamples, setCachedSamples] = useState<any[]>([]);

  const isCheckIn = actionType === 'CHECK_IN';

  const collectGpsSamples = async (): Promise<any[]> => {
    if (!navigator.geolocation) {
      throw new Error('Geolocation tidak didukung oleh browser Anda.');
    }

    return new Promise((resolve) => {
      const samples: any[] = [];
      let count = 0;

      const finish = () => {
        resolve(samples);
      };

      const timeout = setTimeout(finish, 10000); // 10s max

      const id = navigator.geolocation.watchPosition(
        (pos) => {
          samples.push({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy),
          });
          count++;
          if (count >= 3 || pos.coords.accuracy <= 20) {
            navigator.geolocation.clearWatch(id);
            clearTimeout(timeout);
            finish();
          }
        },
        () => {
          clearTimeout(timeout);
          finish();
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    });
  };

  const performAttendance = async (providedNote?: string) => {
    setStatus('LOCATING');
    setErrorMessage('');

    try {
      let samples = cachedSamples;
      if (samples.length === 0) {
        samples = await collectGpsSamples();
        setCachedSamples(samples);
      }

      setStatus('VERIFYING');

      if (isCheckIn) {
        const { challengeId } = await api.requestChallenge('CHECK_IN');
        await api.checkIn({
          challengeId,
          samples,
          note: providedNote || note,
          assignmentId,
        });
      } else {
        await api.checkOut({
          samples,
          note: providedNote || note,
        });
      }

      setStatus('SUCCESS');
      setTimeout(onSuccess, 1000);
    } catch (err: any) {
      console.error(err);
      if (err.message && err.message.includes('Catatan alasan wajib diisi')) {
        setNeedsNote(true);
        setStatus('IDLE');
        setErrorMessage('Lokasi GPS berada di luar cafe atau akurasi rendah. Harap masukkan catatan alasan absensi.');
      } else {
        setStatus('ERROR');
        setErrorMessage(err.message || 'Gagal melakukan absensi.');
      }
    }
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setSliderPos(val);
    if (val >= 95 && status === 'IDLE') {
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
        <div style={{ textAlign: 'center', padding: '20px' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />
          <strong>Mengukur Koordinat GPS...</strong>
          <p className="muted" style={{ fontSize: '12px' }}>Mengambil sample akurasi tinggi</p>
        </div>
      )}

      {status === 'VERIFYING' && (
        <div style={{ textAlign: 'center', padding: '20px' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />
          <strong>Memverifikasi ke Server...</strong>
        </div>
      )}

      {status === 'SUCCESS' && (
        <div style={{ textAlign: 'center', padding: '20px', color: '#1e5b48' }}>
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
        <p className="form-error" style={{ marginBottom: '16px' }}>{errorMessage}</p>
      )}

      {status === 'IDLE' && !needsNote && (
        <div style={{ position: 'relative', marginTop: '16px' }}>
          <div
            style={{
              height: '56px',
              borderRadius: '28px',
              background: '#e0ece6',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#1e5b48',
              fontWeight: 600,
              fontSize: '14px',
              userSelect: 'none',
            }}
          >
            Geser untuk Absen ➔
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={sliderPos}
            onChange={handleSliderChange}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '56px',
              opacity: 0,
              cursor: 'pointer',
            }}
          />
        </div>
      )}

      {onCancel && status === 'IDLE' && (
        <button
          type="button"
          className="outline-button"
          onClick={onCancel}
          style={{ width: '100%', marginTop: '12px' }}
        >
          Batal / Kembali
        </button>
      )}
    </div>
  );
}

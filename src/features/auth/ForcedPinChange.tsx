import { useState } from 'react';
import { api } from '../../lib/api';

type Props = {
  onSuccess: () => void;
};

export function ForcedPinChange({ onSuccess }: Props) {
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPin.length !== 6 || oldPin.length !== 6) {
      setError('PIN harus terdiri dari 6 digit angka.');
      return;
    }
    if (newPin !== confirmPin) {
      setError('Konfirmasi PIN baru tidak sesuai.');
      return;
    }

    setLoading(true);
    try {
      await api.changePin(oldPin, newPin, confirmPin);
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Gagal memperbarui PIN.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-panel" style={{ maxWidth: '440px' }}>
        <div className="login-brand">
          <div><strong>HOPIN</strong><small>KEAMANAN AKUN</small></div>
        </div>
        <div className="login-copy">
          <p className="eyebrow" style={{ color: '#d97706' }}>PIN SEMENTARA TERDETEKSI</p>
          <h1>Wajib Buat PIN Baru</h1>
          <p>Demi keamanan, ganti PIN sementara Anda dengan 6 digit PIN rahasia pribadi.</p>
        </div>

        <form noValidate onSubmit={handleSubmit}>
          <div className="login-field">
            <label>PIN Saat Ini (Sementara)</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={oldPin}
              onChange={(e) => setOldPin(e.target.value.replace(/\D/g, ''))}
              placeholder="••••••"
              style={{ fontSize: '20px', letterSpacing: '6px', textAlign: 'center', width: '100%', padding: '8px' }}
            />
          </div>

          <div className="login-field">
            <label>PIN Baru (6 digit)</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
              placeholder="••••••"
              style={{ fontSize: '20px', letterSpacing: '6px', textAlign: 'center', width: '100%', padding: '8px' }}
            />
          </div>

          <div className="login-field">
            <label>Ulangi PIN Baru</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
              placeholder="••••••"
              style={{ fontSize: '20px', letterSpacing: '6px', textAlign: 'center', width: '100%', padding: '8px' }}
            />
          </div>

          {error && <p className="form-error" role="alert">{error}</p>}

          <button
            className="primary-button"
            type="submit"
            disabled={loading || oldPin.length !== 6 || newPin.length !== 6 || confirmPin.length !== 6}
            style={{ marginTop: '16px' }}
          >
            {loading ? 'Menyimpan...' : 'Simpan PIN & Lanjutkan'}
          </button>
        </form>
      </div>
    </div>
  );
}

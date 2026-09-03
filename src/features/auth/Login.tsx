import { useState, useRef, useEffect } from 'react';

type Props = {
  options: { username: string; display_name: string }[];
  onLogin: (username: string, pin: string) => Promise<void>;
  loading: boolean;
  error: string;
  lockoutSeconds?: number;
};

export function Login({ options, onLogin, loading, error, lockoutSeconds = 0 }: Props) {
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pinInputRef = useRef<HTMLInputElement>(null);
  const submitInFlightRef = useRef(false);
  const prevErrorRef = useRef(error);

  const selectedUser = options.find((o) => o.username === username);
  const disabled = loading || lockoutSeconds > 0;

  // Server-authoritative lock countdown. When it expires, reset input focus.
  useEffect(() => {
    if (lockoutSeconds <= 0) {
      setPin('');
      submitInFlightRef.current = false;
      prevErrorRef.current = error;
      setTimeout(() => {
        document.getElementById('pin-input-0')?.focus();
      }, 50);
    }
  }, [lockoutSeconds === 0]);

  // Clear PIN on every fresh (non-lock) error so the operator can retype.
  useEffect(() => {
    if (error && error !== prevErrorRef.current && lockoutSeconds === 0) {
      setPin('');
      setTimeout(() => {
        document.getElementById('pin-input-0')?.focus();
      }, 50);
    }
    prevErrorRef.current = error;
  }, [error, lockoutSeconds]);

  // Reset the in-flight guard whenever a login attempt has fully settled (loading false).
  useEffect(() => {
    if (!loading) {
      submitInFlightRef.current = false;
    }
  }, [loading]);

  const runLogin = () => {
    if (submitInFlightRef.current || loading || !username || pin.length !== 6 || lockoutSeconds > 0) {
      return;
    }
    submitInFlightRef.current = true;
    void onLogin(username, pin);
  };

  // Auto-submit when all six digits are entered.
  useEffect(() => {
    if (pin.length === 6 && username && !disabled) {
      runLogin();
    }
  }, [pin, username, disabled]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    runLogin();
  };

  return (
    <div className="login-page">
      <div className="login-panel">
        <div className="login-brand">
          <div><strong>HOPIN</strong><small>CAFE OPERATIONS</small></div>
        </div>
        <div className="login-copy">
          <p className="eyebrow">STOK HARI INI · LOGIN USER</p>
          <h1>Mulai shift tanpa<br /><em>catatan tercecer.</em></h1>
          <p>Catat stok Bar dan Kitchen di satu tempat dengan sinkronisasi server resmi.</p>
        </div>
        <form noValidate onSubmit={handleSubmit}>
          <div className="login-field">
            <label htmlFor="user-picker">Nama Lengkap</label>
            <div className="user-picker">
              <button
                id="user-picker"
                type="button"
                className={`user-picker-trigger${pickerOpen ? ' is-open' : ''}`}
                onClick={() => setPickerOpen(!pickerOpen)}
                disabled={disabled || options.length === 0}
              >
                <span className="picker-avatar">
                  {selectedUser ? selectedUser.display_name.slice(0, 2).toUpperCase() : '—'}
                </span>
                <span className="picker-copy">
                  {selectedUser ? (
                    <strong className="picker-name">{selectedUser.display_name}</strong>
                  ) : (
                    <strong className="picker-placeholder">
                      {options.length === 0 ? 'Memuat daftar nama...' : 'Pilih nama Anda...'}
                    </strong>
                  )}
                </span>
                <span className="picker-chevron" aria-hidden="true" />
              </button>
              {pickerOpen && (
                <div className="user-picker-menu" role="listbox">
                  {options.map((opt) => (
                    <button
                      key={opt.username}
                      type="button"
                      className={`user-picker-option${opt.username === username ? ' is-selected' : ''}`}
                      onClick={() => {
                        setUsername(opt.username);
                        setPickerOpen(false);
                        pinInputRef.current?.focus();
                      }}
                    >
                      <span className="picker-option-avatar">{opt.display_name.slice(0, 2).toUpperCase()}</span>
                      <strong className="picker-name">{opt.display_name}</strong>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="login-field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <label htmlFor="pin-input-0" style={{ margin: 0 }}>PIN 6 DIGIT</label>
              <button
                type="button"
                className="pin-toggle"
                onClick={() => setShowPin(!showPin)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: 600,
                  color: '#4a6b5d',
                  padding: '2px 4px',
                }}
              >
                {showPin ? 'Sembunyikan' : 'Lihat'}
              </button>
            </div>
            <div
              className="pin-box-wrap"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(6, 1fr)',
                gap: '8px',
                width: '100%',
                maxWidth: '340px',
                margin: '0 auto',
              }}
              onClick={() => {
                const idx = Math.min(pin.length, 5);
                const el = document.getElementById(`pin-input-${idx}`);
                el?.focus();
              }}
            >
              {[0, 1, 2, 3, 4, 5].map((idx) => {
                const digit = pin[idx] || '';
                return (
                  <input
                    key={idx}
                    id={`pin-input-${idx}`}
                    type={showPin ? 'text' : 'password'}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={1}
                    value={digit}
                    disabled={disabled}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '');
                      if (!val) {
                        const newPin = pin.slice(0, idx) + pin.slice(idx + 1);
                        setPin(newPin);
                        return;
                      }
                      const char = val[val.length - 1];
                      const newPinArr = pin.split('');
                      newPinArr[idx] = char;
                      const nextPin = newPinArr.join('').slice(0, 6);
                      setPin(nextPin);
                      if (idx < 5) {
                        const nextEl = document.getElementById(`pin-input-${idx + 1}`);
                        nextEl?.focus();
                      }
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor = '#1e5b48';
                      e.target.style.boxShadow = '0 0 0 3px rgba(30, 91, 72, 0.16)';
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = digit ? '#1e5b48' : '#cddcd4';
                      e.target.style.boxShadow = 'none';
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Backspace') {
                        if (!digit && idx > 0) {
                          const prevEl = document.getElementById(`pin-input-${idx - 1}`);
                          prevEl?.focus();
                        }
                      }
                    }}
                    onPaste={(e) => {
                      e.preventDefault();
                      const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
                      if (pasted) {
                        setPin(pasted);
                        const targetIdx = Math.min(pasted.length, 5);
                        document.getElementById(`pin-input-${targetIdx}`)?.focus();
                      }
                    }}
                    style={{
                      width: '100%',
                      aspectRatio: '4 / 5',
                      minHeight: '48px',
                      maxHeight: '56px',
                      textAlign: 'center',
                      fontSize: '20px',
                      fontWeight: 700,
                      fontFamily: 'monospace',
                      borderRadius: '10px',
                      border: `1.5px solid ${digit ? '#1e5b48' : '#cddcd4'}`,
                      background: digit ? '#f0f7f4' : '#fff',
                      color: '#123d32',
                      outline: 'none',
                      boxSizing: 'border-box',
                      padding: 0,
                      transition: 'border-color 0.15s, box-shadow 0.15s, background 0.15s',
                    }}
                  />
                );
              })}
            </div>
          </div>

          {lockoutSeconds > 0 && (
            <div
              style={{
                background: '#fff1f2',
                border: '1px solid #fecdd3',
                color: '#be123c',
                padding: '10px 14px',
                borderRadius: '8px',
                fontSize: '12px',
                lineHeight: '1.5',
                marginTop: '12px',
                textAlign: 'center',
              }}
            >
              <strong>Terlalu banyak percobaan salah (3x).</strong>
              <br />
              Silakan tunggu <strong>{lockoutSeconds} detik</strong> sebelum mencoba kembali.
            </div>
          )}

          {error && lockoutSeconds === 0 && <p className="form-error" role="alert">{error}</p>}

          <button
            className="primary-button"
            type="submit"
            disabled={disabled || !username || pin.length !== 6}
          >
            {lockoutSeconds > 0
              ? `Terkunci (${lockoutSeconds}s)`
              : loading
                ? 'Memverifikasi...'
                : 'Masuk ke sistem'} <span>→</span>
          </button>
        </form>
        <p className="demo-hint">Gunakan PIN 6 digit pribadi Anda · Sesi aman terhubung ke server</p>
      </div>

      <div className="login-aside">
        <div className="aside-stamp">OPS<br /><small>PRODUCTION<br />V1.0</small></div>
        <p className="eyebrow">HOPIN OPERATIONS</p>
        <h2>Sistem operasional shift,<br />stok harian, & absensi GPS.</h2>
        <div className="aside-line" />
        <p>Waktu tercatat resmi mengikuti WIB Server.</p>
      </div>
    </div>
  );
}

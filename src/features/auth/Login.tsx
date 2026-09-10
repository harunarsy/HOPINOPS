import { useState, useRef, useEffect } from 'react';

export type ConnectionStatus = 'CHECKING' | 'ONLINE' | 'OFFLINE';

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
  const [transientVisibleIndex, setTransientVisibleIndex] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pinInputRef = useRef<HTMLInputElement>(null);
  const submitInFlightRef = useRef(false);
  const prevErrorRef = useRef(error);
  const transientTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('CHECKING');

  const selectedUser = options.find((o) => o.username === username);
  const disabled = loading || lockoutSeconds > 0;

  useEffect(() => {
    let disposed = false;
    let activeProbe: AbortController | null = null;

    const probe = async () => {
      if (!navigator.onLine) {
        if (!disposed) setConnectionStatus('OFFLINE');
        return;
      }

      activeProbe?.abort();
      activeProbe = new AbortController();
      if (!disposed) setConnectionStatus('CHECKING');
      try {
        const response = await fetch('/api/health', {
          cache: 'no-store',
          signal: activeProbe.signal,
        });
        const body = await response.text();
        if (!disposed) setConnectionStatus(response.ok && body === 'ok' ? 'ONLINE' : 'OFFLINE');
      } catch (probeError: any) {
        if (!disposed && probeError?.name !== 'AbortError') setConnectionStatus('OFFLINE');
      }
    };

    const handleOnline = () => void probe();
    const handleOffline = () => {
      activeProbe?.abort();
      setConnectionStatus('OFFLINE');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    void probe();
    const timer = window.setInterval(() => void probe(), 30_000);

    return () => {
      disposed = true;
      activeProbe?.abort();
      window.clearInterval(timer);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
    };
  }, []);

  const flashDigit = (idx: number) => {
    if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
    setTransientVisibleIndex(idx);
    transientTimerRef.current = setTimeout(() => {
      setTransientVisibleIndex(null);
    }, 800);
  };

  // Server-authoritative lock countdown. When it expires, reset input focus.
  useEffect(() => {
    if (lockoutSeconds <= 0) {
      setPin('');
      setTransientVisibleIndex(null);
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
      setTransientVisibleIndex(null);
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
    if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
    setTransientVisibleIndex(null);
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
            <label htmlFor="user-picker">Pilih Pengguna</label>
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
                      {options.length === 0 ? 'Memuat daftar pengguna...' : 'Pilih pengguna...'}
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
                        setPin('');
                        setTransientVisibleIndex(null);
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
            <label htmlFor="pin-input-0">PIN 6 DIGIT</label>
            <div
              className="pin-rail"
              role="group"
              aria-label="PIN 6 digit"
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
                  setTransientVisibleIndex(null);
                }
              }}
              onClick={(event) => {
                if (event.target !== event.currentTarget) return;
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
                    ref={idx === 0 ? pinInputRef : undefined}
                    aria-label={`Digit PIN ${idx + 1} dari 6`}
                    type={transientVisibleIndex === idx ? 'text' : 'password'}
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
                        setTransientVisibleIndex(null);
                        return;
                      }
                      const char = val[val.length - 1];
                      const newPinArr = pin.split('');
                      newPinArr[idx] = char;
                      const nextPin = newPinArr.join('').slice(0, 6);
                      setPin(nextPin);
                      flashDigit(idx);
                      if (idx < 5) {
                        const nextEl = document.getElementById(`pin-input-${idx + 1}`);
                        nextEl?.focus();
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Backspace') {
                        if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
                        setTransientVisibleIndex(null);
                        if (!digit && idx > 0) {
                          const prevEl = document.getElementById(`pin-input-${idx - 1}`);
                          prevEl?.focus();
                        }
                      }
                    }}
                    onPaste={(e) => {
                      e.preventDefault();
                      if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
                      setTransientVisibleIndex(null);
                      const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
                      if (pasted) {
                        setPin(pasted);
                        const targetIdx = Math.min(pasted.length, 5);
                        document.getElementById(`pin-input-${targetIdx}`)?.focus();
                      }
                    }}
                  />
                );
              })}
            </div>
          </div>

          {lockoutSeconds > 0 && (
            <div
              role="alert"
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
        <div className={`login-connection login-connection-${connectionStatus.toLowerCase()}`} aria-live="polite">
          <span>Gunakan PIN 6 digit pribadi Anda</span>
          <span className="connection-status-line">
            <span className="connection-status-icon" aria-hidden="true" />
            {connectionStatus === 'ONLINE'
              ? 'Server terhubung'
              : connectionStatus === 'CHECKING'
                ? 'Memeriksa koneksi server…'
                : 'Server tidak terjangkau'}
          </span>
        </div>
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

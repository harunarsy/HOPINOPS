import { useState, useRef } from 'react';

type Props = {
  options: { username: string; display_name: string }[];
  onLogin: (username: string, pin: string) => Promise<void>;
  loading: boolean;
  error: string;
};

export function Login({ options, onLogin, loading, error }: Props) {
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pinInputRef = useRef<HTMLInputElement>(null);

  const selectedUser = options.find((o) => o.username === username);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || pin.length !== 6) return;
    void onLogin(username, pin);
  };

  const handlePinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\D/g, '').slice(0, 6);
    setPin(val);
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
                disabled={loading || options.length === 0}
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
            <label htmlFor="pin-input">PIN 6 digit</label>
            <div className="pin-entry" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                id="pin-input"
                ref={pinInputRef}
                type={showPin ? 'text' : 'password'}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={pin}
                onChange={handlePinChange}
                placeholder="••••••"
                disabled={loading}
                style={{
                  fontSize: '24px',
                  letterSpacing: '8px',
                  textAlign: 'center',
                  padding: '10px 14px',
                  borderRadius: '10px',
                  border: '1px solid #cddcd4',
                  width: '100%',
                  fontFamily: 'monospace',
                }}
              />
              <button
                type="button"
                className="pin-toggle"
                onClick={() => setShowPin(!showPin)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#4a6b5d' }}
              >
                {showPin ? 'Sembunyikan' : 'Lihat'}
              </button>
            </div>
          </div>

          {error && <p className="form-error" role="alert">{error}</p>}

          <button
            className="primary-button"
            type="submit"
            disabled={loading || !username || pin.length !== 6}
          >
            {loading ? 'Memverifikasi...' : 'Masuk ke sistem'} <span>→</span>
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

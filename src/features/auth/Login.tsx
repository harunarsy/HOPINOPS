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
            <label htmlFor="pin-input-0">PIN 6 digit</label>
            <div
              className="pin-box-wrap"
              style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '6px' }}
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
                    disabled={loading}
                    placeholder={idx === 0 && !pin ? '•' : ''}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, '');
                      if (!val) {
                        // clear current digit
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
                      width: '46px',
                      height: '54px',
                      textAlign: 'center',
                      fontSize: '22px',
                      fontWeight: 700,
                      fontFamily: 'monospace',
                      borderRadius: '10px',
                      border: `1.5px solid ${digit ? '#1e5b48' : '#cddcd4'}`,
                      background: digit ? '#f0f7f4' : '#fff',
                      color: '#123d32',
                      outline: 'none',
                      transition: 'border-color 0.15s, background 0.15s',
                    }}
                  />
                );
              })}
            </div>
            <div style={{ textAlign: 'right', marginTop: '6px' }}>
              <button
                type="button"
                className="pin-toggle"
                onClick={() => setShowPin(!showPin)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', color: '#4a6b5d' }}
              >
                {showPin ? 'Sembunyikan PIN' : 'Lihat PIN'}
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

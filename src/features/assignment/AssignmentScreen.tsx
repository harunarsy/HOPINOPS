import { useState } from 'react';
import type { ShiftType, Area, DutyRole } from '../../domain/types';
import { shiftOptions, areaLabel } from '../../domain/rules';

type Props = {
  name: string;
  onClaim: (shift: ShiftType, area: Area, duty: DutyRole) => Promise<void>;
  loading: boolean;
  onLogout: () => void;
};

export function AssignmentScreen({ name, onClaim, loading, onLogout }: Props) {
  const [shift, setShift] = useState<ShiftType>('SIANG');
  const [area, setArea] = useState<Area>('BAR');
  const [duty, setDuty] = useState<DutyRole>('PRIMARY');
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span><strong>HOPIN</strong><small>PENUGASAN SHIFT</small></span>
        </div>
        <div className="topbar-right">
          <button className="logout-button" onClick={onLogout}>
            <span>Keluar</span>
          </button>
        </div>
      </header>

      <main className="workspace" style={{ maxWidth: '580px', margin: '0 auto' }}>
        <section className="welcome">
          <div>
            <p className="eyebrow">PILIH TUGAS HARI INI</p>
            <h1>Halo, {name}.</h1>
            <p className="muted">Tentukan shift, area kerja, dan peran Anda sebelum memulai shift.</p>
          </div>
        </section>

        <section className="section-card" style={{ marginTop: '16px' }}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">1. PILIH SHIFT</p>
              <h3>Jadwal Kerja</h3>
            </div>
          </div>
          <div style={{ display: 'grid', gap: '8px', marginTop: '12px' }}>
            {(Object.keys(shiftOptions) as ShiftType[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`area-button${shift === s ? ' selected' : ''}`}
                onClick={() => setShift(s)}
                style={{ textAlign: 'left', width: '100%' }}
              >
                <div>
                  <strong>{shiftOptions[s].label}</strong>
                  <small style={{ display: 'block', color: '#6b8378' }}>{shiftOptions[s].hours}</small>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="section-card" style={{ marginTop: '16px' }}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">2. PILIH AREA & PERAN</p>
              <h3>Stasiun Kerja</h3>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '12px' }}>
            {(['BAR', 'KITCHEN'] as Area[]).map((a) => (
              <button
                key={a}
                type="button"
                className={`area-button${area === a ? ' selected' : ''}`}
                onClick={() => setArea(a)}
              >
                <span className="area-symbol">{a === 'BAR' ? '◒' : '⌁'}</span>
                <strong>{areaLabel(a)}</strong>
              </button>
            ))}
          </div>

          <div style={{ marginTop: '16px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#6b8378', display: 'block', marginBottom: '6px' }}>
              Peran Tugas
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <button
                type="button"
                className={`segmented-btn ${duty === 'PRIMARY' ? 'active' : ''}`}
                onClick={() => setDuty('PRIMARY')}
                style={{
                  padding: '10px',
                  borderRadius: '8px',
                  border: '1px solid #cddcd4',
                  background: duty === 'PRIMARY' ? '#1e5b48' : '#fff',
                  color: duty === 'PRIMARY' ? '#fff' : '#1a332a',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Penanggung Jawab (Utama)
              </button>
              <button
                type="button"
                className={`segmented-btn ${duty === 'HELPER' ? 'active' : ''}`}
                onClick={() => setDuty('HELPER')}
                style={{
                  padding: '10px',
                  borderRadius: '8px',
                  border: '1px solid #cddcd4',
                  background: duty === 'HELPER' ? '#1e5b48' : '#fff',
                  color: duty === 'HELPER' ? '#fff' : '#1a332a',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Bantuan (Helper)
              </button>
            </div>
          </div>
        </section>

        <div style={{ marginTop: '24px' }}>
          <button
            type="button"
            className="primary-button"
            onClick={() => setConfirmOpen(true)}
            disabled={loading}
            style={{ width: '100%' }}
          >
            Lanjut ke Absensi GPS →
          </button>
        </div>

        {confirmOpen && (
          <div className="modal-backdrop" role="presentation">
            <div className="modal" style={{ maxWidth: '400px' }}>
              <div className="modal-head">
                <h3>Konfirmasi Penugasan</h3>
                <button className="close-button" onClick={() => setConfirmOpen(false)}>×</button>
              </div>
              <p style={{ fontSize: '14px', margin: '16px 0', lineHeight: 1.5 }}>
                Anda akan bertugas di <strong>{areaLabel(area)}</strong> ({shiftOptions[shift].label}) sebagai <strong>{duty === 'PRIMARY' ? 'Penanggung Jawab Utama' : 'Bantuan'}</strong>.
              </p>
              <div className="modal-actions">
                <button className="outline-button" onClick={() => setConfirmOpen(false)}>Ubah</button>
                <button
                  className="primary-button"
                  onClick={() => {
                    setConfirmOpen(false);
                    void onClaim(shift, area, duty);
                  }}
                  disabled={loading}
                >
                  {loading ? 'Memproses...' : 'Konfirmasi & Masuk'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

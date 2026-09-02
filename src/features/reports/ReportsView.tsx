import { useState } from 'react';
import type { FinanceData } from '../../domain/types';
import { fmtRupiah, wibDate } from '../../domain/rules';
import { api } from '../../lib/api';

type Props = {
  isFinalizer: boolean;
  workDate: string;
  onRefresh: () => Promise<void>;
  onBack: () => void;
};

export function ReportsView({ isFinalizer, workDate, onRefresh, onBack }: Props) {
  const [finance, setFinance] = useState<FinanceData>({
    cash_real: 0,
    cash_app: 0,
    qris_mandiri: 0,
    debit_mandiri: 0,
  });
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');

  const recordedTotal = Number(finance.cash_app) + Number(finance.qris_mandiri) + Number(finance.debit_mandiri);
  const receivedTotal = Number(finance.cash_real) + Number(finance.qris_mandiri) + Number(finance.debit_mandiri);
  const cashDiff = Number(finance.cash_real) - Number(finance.cash_app);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const handleSubmitReport = async () => {
    setLoading(true);
    try {
      await api.submitReport(workDate, finance);
      showToast('Laporan harian berhasil dikirim ke Manajemen.');
      await onRefresh();
    } catch (err: any) {
      showToast(err.message || 'Gagal mengirim laporan');
    } finally {
      setLoading(false);
    }
  };

  const handleShareWa = async () => {
    const text = `*HOPIN CAFE - LAPORAN HARIAN*\nTanggal: ${wibDate()}\nTotal Transaksi (Sistem): ${fmtRupiah(recordedTotal)}\nTotal Uang Masuk: ${fmtRupiah(receivedTotal)}\nSelisih Kas Fisik: ${fmtRupiah(cashDiff)}\n\nLihat detail & verifikasi di aplikasi HOPIN OPS: https://hopinops.vercel.app`;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        showToast('Ringkasan disalin! Tinggal paste ke WhatsApp.');
      } else {
        showToast('Gagal menyalin ringkasan.');
      }
    } catch {
      showToast('Gagal menyalin ringkasan.');
    }
  };

  return (
    <div className="workspace" style={{ maxWidth: '560px', margin: '0 auto' }}>
      <section className="welcome">
        <div>
          <p className="eyebrow">FINALISASI OPERASIONAL HARIAN</p>
          <h1>Laporan Harian</h1>
          <p className="muted">Rekonsiliasi keuangan kas, QRIS, dan debit hari ini.</p>
        </div>
        <button className="outline-button" onClick={onBack}>
          ← Kembali ke Workspace
        </button>
      </section>

      <section className="section-card" style={{ marginTop: '16px' }}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">REKONSILIASI KAS & DIGITAL</p>
            <h2>Rincian Keuangan</h2>
          </div>
        </div>

        <div style={{ display: 'grid', gap: '12px', marginTop: '16px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>
              Cash POS / Aplikasi (Sistem)
            </label>
            <input
              type="number"
              value={finance.cash_app || ''}
              onChange={(e) => setFinance({ ...finance, cash_app: Number(e.target.value) })}
              placeholder="0"
              style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid #cddcd4' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>
              Cash Fisik Nyata (Hitung Brankas/Laci)
            </label>
            <input
              type="number"
              value={finance.cash_real || ''}
              onChange={(e) => setFinance({ ...finance, cash_real: Number(e.target.value) })}
              placeholder="0"
              style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid #cddcd4' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>
              QRIS Mandiri (Net Settlement)
            </label>
            <input
              type="number"
              value={finance.qris_mandiri || ''}
              onChange={(e) => setFinance({ ...finance, qris_mandiri: Number(e.target.value) })}
              placeholder="0"
              style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid #cddcd4' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>
              Debit Mandiri (Net EDC)
            </label>
            <input
              type="number"
              value={finance.debit_mandiri || ''}
              onChange={(e) => setFinance({ ...finance, debit_mandiri: Number(e.target.value) })}
              placeholder="0"
              style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid #cddcd4' }}
            />
          </div>
        </div>

        <div style={{ marginTop: '20px', padding: '16px', background: '#f8faf9', borderRadius: '10px', border: '1px solid #e0ece6' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ color: '#6b8378' }}>Total Transaksi Tercatat:</span>
            <strong>{fmtRupiah(recordedTotal)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ color: '#6b8378' }}>Total Uang Masuk Aktual:</span>
            <strong>{fmtRupiah(receivedTotal)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed #cddcd4', paddingTop: '8px' }}>
            <span style={{ color: '#6b8378' }}>Selisih Kas Fisik:</span>
            <strong style={{ color: cashDiff < 0 ? '#b91c1c' : '#1e5b48' }}>
              {cashDiff < 0 ? '-' : '+'}{fmtRupiah(Math.abs(cashDiff))}
            </strong>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button
            className="outline-button"
            onClick={handleShareWa}
            style={{ flex: 1 }}
          >
            Salin Pesan WA 📋
          </button>

          <button
            className="primary-button"
            onClick={handleSubmitReport}
            disabled={loading || !isFinalizer}
            style={{ flex: 1.5 }}
          >
            {loading ? 'Mengirim...' : 'Kirim Laporan Resmi →'}
          </button>
        </div>
      </section>

      {toast && <div className="live-region" role="status">{toast}</div>}
    </div>
  );
}

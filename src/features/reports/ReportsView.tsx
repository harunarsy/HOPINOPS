import { useEffect, useState } from 'react';
import type { FinanceData } from '../../domain/types';
import { fmtRupiah } from '../../domain/rules';
import { api } from '../../lib/api';

type Props = {
  isFinalizer: boolean;
  workDate: string;
  onRefresh: () => Promise<void>;
  onBack: () => void;
};

type FinanceDraft = Record<keyof FinanceData, string>;
type ManagerReport = {
  id: string;
  work_date: string;
  status: string;
  current_revision: number;
  updated_at: string;
};
type ReportReceipt = {
  report_id?: string;
  revision_id?: string;
  public_id?: string;
  status?: string;
};
type LoadState = 'checking' | 'not-applicable' | 'loading' | 'success' | 'error';
type SubmitState = 'idle' | 'loading' | 'success' | 'error';

const financeFields: { key: keyof FinanceData; label: string; help: string }[] = [
  { key: 'cash_app', label: 'Cash POS / Aplikasi (Sistem)', help: 'Nilai cash yang tercatat di POS.' },
  { key: 'cash_real', label: 'Cash Fisik Nyata (Hitung Brankas/Laci)', help: 'Nilai cash hasil hitung fisik.' },
  { key: 'qris_mandiri', label: 'QRIS Mandiri (Net Settlement)', help: 'Nilai settlement QRIS bersih.' },
  { key: 'debit_mandiri', label: 'Debit Mandiri (Net EDC)', help: 'Nilai settlement debit EDC bersih.' },
];

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ReportsView({ isFinalizer, workDate, onRefresh, onBack }: Props) {
  const [finance, setFinance] = useState<FinanceDraft>({
    cash_real: '0',
    cash_app: '0',
    qris_mandiri: '0',
    debit_mandiri: '0',
  });
  const [managerLoadState, setManagerLoadState] = useState<LoadState>('checking');
  const [managerLoadError, setManagerLoadError] = useState('');
  const [managerReports, setManagerReports] = useState<ManagerReport[]>([]);
  const [isManager, setIsManager] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [submitMessage, setSubmitMessage] = useState('');
  const [refreshWarning, setRefreshWarning] = useState('');
  const [receipt, setReceipt] = useState<ReportReceipt | null>(null);
  const [shareMessage, setShareMessage] = useState('');

  useEffect(() => {
    let active = true;

    const loadManagerReports = async () => {
      try {
        const user = await api.getCurrentUser();
        if (!active) return;
        if (user?.role !== 'OWNER' && user?.role !== 'SUPERVISOR') {
          setManagerLoadState('not-applicable');
          return;
        }

        setIsManager(true);
        setManagerLoadState('loading');
        const reports = await api.listReports();
        if (!active) return;
        setManagerReports(reports);
        setManagerLoadState('success');
      } catch (error) {
        if (!active) return;
        setManagerLoadError(messageFrom(error, 'Daftar laporan manajemen gagal dimuat.'));
        setManagerLoadState('error');
      }
    };

    void loadManagerReports();
    return () => {
      active = false;
    };
  }, [workDate]);

  const financeErrors = Object.fromEntries(
    financeFields.map(({ key }) => {
      const value = finance[key].trim();
      const valid = /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
      return [key, valid ? '' : 'Wajib bilangan bulat 0 atau lebih dalam rentang aman.'];
    }),
  ) as Record<keyof FinanceData, string>;
  const financeIsValid = Object.values(financeErrors).every((error) => !error);
  const parsedFinance = financeIsValid
    ? Object.fromEntries(Object.entries(finance).map(([key, value]) => [key, Number(value)])) as FinanceData
    : null;
  const recordedTotal = parsedFinance
    ? parsedFinance.cash_app + parsedFinance.qris_mandiri + parsedFinance.debit_mandiri
    : null;
  const receivedTotal = parsedFinance
    ? parsedFinance.cash_real + parsedFinance.qris_mandiri + parsedFinance.debit_mandiri
    : null;
  const cashDiff = parsedFinance ? parsedFinance.cash_real - parsedFinance.cash_app : null;
  const currentReport = managerReports.find((report) => report.work_date === workDate);
  const receiptFields = receipt
    ? [
        receipt.report_id ? `ID laporan: ${receipt.report_id}` : '',
        receipt.revision_id ? `ID revisi: ${receipt.revision_id}` : '',
        receipt.public_id ? `ID publik: ${receipt.public_id}` : '',
        receipt.status ? `Status: ${receipt.status}` : '',
      ].filter(Boolean)
    : [];
  const canShareReceipt = submitState === 'success' && receiptFields.length > 0;
  const fieldsDisabled = submitState === 'loading' || submitState === 'success' || !isFinalizer;
  const submitDisabledReason = submitState === 'loading'
    ? 'Pengiriman sedang diproses oleh server.'
    : submitState === 'success'
      ? 'Laporan sudah terkirim. Receipt server tersedia di bawah.'
      : !isFinalizer
        ? 'Hanya primary BAR shift MALAM/FULL atau manajemen yang dapat mengirim laporan.'
        : !financeIsValid
          ? 'Perbaiki semua nilai keuangan sebelum mengirim.'
          : '';

  const handleSubmitReport = async () => {
    if (!parsedFinance || !isFinalizer || submitState === 'loading' || submitState === 'success') return;

    setSubmitState('loading');
    setSubmitMessage('Mengirim finance dan meminta validasi kesiapan dari server...');
    setRefreshWarning('');
    setShareMessage('');

    let serverReceipt: ReportReceipt;
    try {
      serverReceipt = await api.submitReport(workDate, parsedFinance) as ReportReceipt;
    } catch (error) {
      setSubmitState('error');
      setSubmitMessage(messageFrom(error, 'Laporan gagal dikirim. Data belum dinyatakan terkirim.'));
      return;
    }

    setReceipt(serverReceipt);
    setSubmitState('success');
    setSubmitMessage('Laporan diterima server. Simpan receipt berikut sebagai bukti pengiriman.');

    try {
      await onRefresh();
    } catch (error) {
      setRefreshWarning(`Laporan sudah terkirim, tetapi workspace gagal diperbarui: ${messageFrom(error, 'Muat ulang workspace.')}`);
    }

    if (isManager) {
      setManagerLoadState('loading');
      try {
        const reports = await api.listReports();
        setManagerReports(reports);
        setManagerLoadState('success');
        setManagerLoadError('');
      } catch (error) {
        setManagerLoadError(messageFrom(error, 'Daftar laporan gagal diperbarui setelah submit.'));
        setManagerLoadState('error');
      }
    }
  };

  const handleShareReceipt = async () => {
    if (!canShareReceipt) return;
    const text = receiptFields.join('\n');

    try {
      if (navigator.share) {
        await navigator.share({ title: 'Receipt laporan harian HOPIN', text });
        setShareMessage('Receipt server berhasil dibagikan.');
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setShareMessage('Receipt server disalin. Tempelkan ke WhatsApp bila diperlukan.');
      } else {
        setShareMessage('Browser ini tidak mendukung berbagi atau clipboard. Salin ID receipt secara manual.');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setShareMessage('Berbagi receipt dibatalkan.');
      } else {
        setShareMessage('Receipt server gagal dibagikan atau disalin. ID tetap tersedia di bawah.');
      }
    }
  };

  return (
    <div className="workspace" style={{ maxWidth: '560px', margin: '0 auto' }}>
      <section className="welcome">
        <div>
          <p className="eyebrow">FINALISASI OPERASIONAL HARIAN</p>
          <h1>Laporan Harian</h1>
          <p className="muted">Rekonsiliasi keuangan untuk tanggal kerja {workDate}.</p>
        </div>
        <button className="outline-button" onClick={onBack}>
          Kembali ke Workspace
        </button>
      </section>

      {managerLoadState !== 'not-applicable' && (
        <section className="section-card" aria-labelledby="manager-reports-title" style={{ marginBottom: '16px' }}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">STATUS SERVER MANAJEMEN</p>
              <h2 id="manager-reports-title">Daftar Laporan</h2>
            </div>
          </div>

          {(managerLoadState === 'checking' || managerLoadState === 'loading') && (
            <p role="status" style={{ margin: '16px 0 0', color: '#547066' }}>
              {managerLoadState === 'checking' ? 'Memeriksa akses daftar laporan...' : 'Memuat status laporan dari server...'}
            </p>
          )}

          {managerLoadState === 'error' && (
            <div role="alert" className="form-error" style={{ margin: '16px 0 0' }}>
              Status laporan tidak dapat dimuat: {managerLoadError}
            </div>
          )}

          {managerLoadState === 'success' && (
            <div style={{ display: 'grid', gap: '12px', marginTop: '16px' }}>
              <div role="status" style={{ padding: '12px', borderRadius: '10px', background: '#e4f1e8', color: '#1e5b48' }}>
                <strong>Status {workDate}: </strong>
                {currentReport ? `${currentReport.status} (revisi ${currentReport.current_revision})` : 'Belum ada laporan di server.'}
              </div>
              {managerReports.length > 0 ? (
                <ul aria-label="Laporan terbaru" style={{ display: 'grid', gap: '8px', margin: 0, padding: 0, listStyle: 'none' }}>
                  {managerReports.map((report) => (
                    <li key={report.id} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '6px 12px', padding: '10px 12px', border: '1px solid #e0ece6', borderRadius: '9px' }}>
                      <strong>{report.work_date}</strong>
                      <span style={{ color: '#547066' }}>{report.status} / revisi {report.current_revision}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Daftar laporan server masih kosong.</p>
              )}
            </div>
          )}
        </section>
      )}

      <section className="section-card" aria-labelledby="finance-title" style={{ marginTop: '16px' }}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">REKONSILIASI KAS & DIGITAL</p>
            <h2 id="finance-title">Rincian Keuangan</h2>
          </div>
        </div>

        <div style={{ marginTop: '16px', padding: '12px', borderRadius: '10px', border: '1px solid #f0d8a9', background: '#fff3dd', color: '#7d5b2b' }}>
          <strong>Kesiapan diperiksa saat submit.</strong> Server mewajibkan tepat satu closing terkonfirmasi dan lengkap untuk BAR serta KITCHEN. Pastikan antrean sinkronisasi perangkat kosong sebelum mengirim. Pemeriksaan awal belum tersedia karena <code>report.get</code> belum tersedia.
        </div>

        <form onSubmit={(event) => { event.preventDefault(); void handleSubmitReport(); }} noValidate>
          <div style={{ display: 'grid', gap: '12px', marginTop: '16px' }}>
            {financeFields.map(({ key, label, help }) => {
              const inputId = `report-${key}`;
              const errorId = `${inputId}-error`;
              return (
                <div key={key}>
                  <label htmlFor={inputId} style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>
                    {label}
                  </label>
                  <input
                    id={inputId}
                    name={key}
                    type="number"
                    min="0"
                    step="1"
                    inputMode="numeric"
                    required
                    value={finance[key]}
                    disabled={fieldsDisabled}
                    aria-invalid={Boolean(financeErrors[key])}
                    aria-describedby={financeErrors[key] ? errorId : undefined}
                    onChange={(event) => {
                      setFinance((current) => ({ ...current, [key]: event.target.value }));
                      setSubmitState('idle');
                      setSubmitMessage('');
                      setShareMessage('');
                    }}
                    placeholder="0"
                    title={help}
                    style={{ width: '100%', padding: '8px', borderRadius: '8px', border: financeErrors[key] ? '1px solid #b95745' : '1px solid #cddcd4' }}
                  />
                  {financeErrors[key] && (
                    <p id={errorId} style={{ margin: '4px 0 0', color: '#8f3f34', fontSize: '11px' }}>
                      {financeErrors[key]}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: '20px', padding: '16px', background: '#f8faf9', borderRadius: '10px', border: '1px solid #e0ece6' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '6px 12px', marginBottom: '8px' }}>
              <span style={{ color: '#6b8378' }}>Total Transaksi Tercatat:</span>
              <strong>{recordedTotal === null ? 'Nilai belum valid' : fmtRupiah(recordedTotal)}</strong>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '6px 12px', marginBottom: '8px' }}>
              <span style={{ color: '#6b8378' }}>Total Uang Masuk Aktual:</span>
              <strong>{receivedTotal === null ? 'Nilai belum valid' : fmtRupiah(receivedTotal)}</strong>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '6px 12px', borderTop: '1px dashed #cddcd4', paddingTop: '8px' }}>
              <span style={{ color: '#6b8378' }}>Selisih Kas Fisik:</span>
              <strong style={{ color: cashDiff !== null && cashDiff < 0 ? '#b91c1c' : '#1e5b48' }}>
                {cashDiff === null ? 'Nilai belum valid' : `${cashDiff < 0 ? '-' : '+'}${fmtRupiah(Math.abs(cashDiff))}`}
              </strong>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginTop: '20px' }}>
            <button
              type="button"
              className="outline-button"
              onClick={() => { void handleShareReceipt(); }}
              disabled={!canShareReceipt}
              aria-describedby="share-limitation"
              style={{ width: '100%' }}
            >
              Bagikan / Salin Receipt
            </button>

            <button
              type="submit"
              className="primary-button"
              disabled={Boolean(submitDisabledReason) || !financeIsValid}
              aria-describedby={submitDisabledReason ? 'submit-disabled-reason' : 'readiness-note'}
              style={{ width: '100%' }}
            >
              {submitState === 'loading' ? 'Mengirim...' : submitState === 'success' ? 'Laporan Terkirim' : 'Kirim Laporan Resmi'}
            </button>
          </div>

          <p id="share-limitation" className="muted" style={{ marginTop: '10px', fontSize: '11px' }}>
            Ringkasan server belum dapat dibagikan karena <code>report.share</code> belum tersedia. Tombol hanya aktif setelah submit sukses dan hanya memakai field receipt server, bukan draft finance di browser.
          </p>
          <p id="readiness-note" className="muted" style={{ marginTop: '6px', fontSize: '11px' }}>
            Draft server belum tersedia karena <code>report.finance.save</code> belum tersedia. Nilai dikirim langsung saat submit.
          </p>
          {submitDisabledReason && (
            <p id="submit-disabled-reason" style={{ margin: '6px 0 0', color: '#7d5b2b', fontSize: '11px' }}>
              Tombol kirim nonaktif: {submitDisabledReason}
            </p>
          )}
        </form>

        {submitState !== 'idle' && (
          <div
            role={submitState === 'error' ? 'alert' : 'status'}
            style={{ marginTop: '16px', padding: '12px', borderRadius: '10px', border: `1px solid ${submitState === 'error' ? '#e6b9b0' : '#c6dfd0'}`, background: submitState === 'error' ? '#fbe8e4' : '#e4f1e8', color: submitState === 'error' ? '#8f3f34' : '#1e5b48' }}
          >
            {submitMessage}
          </div>
        )}

        {refreshWarning && (
          <div role="alert" style={{ marginTop: '10px', padding: '12px', borderRadius: '10px', border: '1px solid #f0d8a9', background: '#fff3dd', color: '#7d5b2b' }}>
            {refreshWarning}
          </div>
        )}

        {receipt && (
          <section aria-labelledby="receipt-title" style={{ marginTop: '16px', padding: '16px', borderRadius: '10px', border: '1px solid #c6dfd0', background: '#f8faf9' }}>
            <p className="eyebrow">BUKTI DARI SERVER</p>
            <h3 id="receipt-title">Receipt Pengiriman</h3>
            {receiptFields.length > 0 ? (
              <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(100px, auto) minmax(0, 1fr)', gap: '8px 12px', margin: '12px 0 0' }}>
                {receipt.report_id && <><dt>ID laporan</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{receipt.report_id}</dd></>}
                {receipt.revision_id && <><dt>ID revisi</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{receipt.revision_id}</dd></>}
                {receipt.public_id && <><dt>ID publik</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{receipt.public_id}</dd></>}
                {receipt.status && <><dt>Status</dt><dd style={{ margin: 0 }}>{receipt.status}</dd></>}
              </dl>
            ) : (
              <p role="alert" style={{ color: '#8f3f34', margin: '12px 0 0' }}>
                Server menyatakan submit sukses, tetapi tidak mengembalikan field receipt yang dapat dibagikan.
              </p>
            )}
          </section>
        )}

        {shareMessage && <p role="status" style={{ margin: '10px 0 0', color: '#547066' }}>{shareMessage}</p>}
      </section>
    </div>
  );
}

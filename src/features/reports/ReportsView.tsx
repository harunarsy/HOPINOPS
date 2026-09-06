import { useEffect, useRef, useState } from 'react';
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
type ReportSnapshot = {
  report: ({ id: string; status: string; current_revision: number; version: number } & Record<string, unknown>) | null;
  revision: ({ id: string; public_id?: string; status: string } & Record<string, unknown>) | null;
  finance: (FinanceData & Record<string, unknown>) | null;
  stock_lines: unknown[];
  finance_draft: ({ version: number; finance_json: FinanceData } & Record<string, unknown>) | null;
};
type LoadState = 'checking' | 'not-applicable' | 'loading' | 'success' | 'error';
type OperationState = 'idle' | 'loading' | 'success' | 'error';

const emptyFinance: FinanceDraft = {
  cash_real: '0',
  cash_app: '0',
  qris_mandiri: '0',
  debit_mandiri: '0',
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const financeFields: { key: keyof FinanceData; label: string; help: string }[] = [
  { key: 'cash_app', label: 'Cash POS / Aplikasi (Sistem)', help: 'Nilai cash yang tercatat di POS.' },
  { key: 'cash_real', label: 'Cash Fisik Nyata (Hitung Brankas/Laci)', help: 'Nilai cash hasil hitung fisik.' },
  { key: 'qris_mandiri', label: 'QRIS Mandiri (Net Settlement)', help: 'Nilai settlement QRIS bersih.' },
  { key: 'debit_mandiri', label: 'Debit Mandiri (Net EDC)', help: 'Nilai settlement debit EDC bersih.' },
];

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function codeFrom(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
}

function parseServerFinance(value: unknown): FinanceData | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const parsed = financeFields.map(({ key }) => source[key]);
  if (!parsed.every((amount) => typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0)) return null;
  return {
    cash_real: source.cash_real as number,
    cash_app: source.cash_app as number,
    qris_mandiri: source.qris_mandiri as number,
    debit_mandiri: source.debit_mandiri as number,
  };
}

function financeToInputs(value: FinanceData): FinanceDraft {
  return {
    cash_real: String(value.cash_real),
    cash_app: String(value.cash_app),
    qris_mandiri: String(value.qris_mandiri),
    debit_mandiri: String(value.debit_mandiri),
  };
}

function financeFromSnapshot(snapshot: ReportSnapshot) {
  const immutable = Boolean(snapshot.report && !['DRAFT', 'NEEDS_CLARIFICATION'].includes(snapshot.report.status));
  return immutable ? snapshot.finance : snapshot.finance_draft?.finance_json ?? snapshot.finance;
}

function receiptFromReport(snapshot: ReportSnapshot): ReportReceipt | null {
  if (!snapshot.report && !snapshot.revision) return null;
  return {
    report_id: snapshot.report?.id,
    revision_id: snapshot.revision?.id,
    public_id: snapshot.revision?.public_id,
    status: snapshot.revision?.status ?? snapshot.report?.status,
  };
}

export function ReportsView({ isFinalizer, workDate, onRefresh, onBack }: Props) {
  const [finance, setFinance] = useState<FinanceDraft>(emptyFinance);
  const [reportLoadState, setReportLoadState] = useState<OperationState>('loading');
  const [reportLoadError, setReportLoadError] = useState('');
  const [reportSnapshot, setReportSnapshot] = useState<ReportSnapshot | null>(null);
  const [serverDraftFinance, setServerDraftFinance] = useState<FinanceData | null>(null);
  const [financeDirty, setFinanceDirty] = useState(false);
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [draftState, setDraftState] = useState<OperationState>('idle');
  const [draftMessage, setDraftMessage] = useState('');
  const [managerLoadState, setManagerLoadState] = useState<LoadState>('checking');
  const [managerLoadError, setManagerLoadError] = useState('');
  const [managerReports, setManagerReports] = useState<ManagerReport[]>([]);
  const [isManager, setIsManager] = useState(false);
  const [submitState, setSubmitState] = useState<OperationState>('idle');
  const [submitMessage, setSubmitMessage] = useState('');
  const [refreshWarning, setRefreshWarning] = useState('');
  const [receipt, setReceipt] = useState<ReportReceipt | null>(null);
  const [shareState, setShareState] = useState<OperationState>('idle');
  const [shareMessage, setShareMessage] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [shareReason, setShareReason] = useState('');
  const draftIdempotencyKeyRef = useRef<string | null>(null);
  const draftInFlightRef = useRef(false);
  const shareIdempotencyKeyRef = useRef<string | null>(null);
  const shareInFlightRef = useRef(false);

  useEffect(() => {
    let active = true;

    setReportLoadState('loading');
    setReportLoadError('');
    setReportSnapshot(null);
    setFinance({ ...emptyFinance });
    setServerDraftFinance(null);
    setFinanceDirty(false);
    setDraftVersion(null);
    setDraftState('idle');
    setDraftMessage('');
    setSubmitState('idle');
    setSubmitMessage('');
    setRefreshWarning('');
    setReceipt(null);
    setShareState('idle');
    setShareMessage('');
    setRecipientId('');
    setShareReason('');
    draftIdempotencyKeyRef.current = null;
    shareIdempotencyKeyRef.current = null;

    const loadReport = async () => {
      try {
        const snapshot = await api.getReport(workDate) as ReportSnapshot;
        if (!active) return;
        const financeSource = financeFromSnapshot(snapshot);
        const hydratedFinance = financeSource === null ? null : parseServerFinance(financeSource);
        if (financeSource !== null && !hydratedFinance) {
          throw new Error('Finance server tidak valid dan tidak dapat dimuat dengan aman.');
        }
        if (snapshot.finance_draft && (!Number.isInteger(snapshot.finance_draft.version) || snapshot.finance_draft.version <= 0)) {
          throw new Error('Versi draft finance dari server tidak valid.');
        }

        setReportSnapshot(snapshot);
        setFinance(hydratedFinance ? financeToInputs(hydratedFinance) : { ...emptyFinance });
        setServerDraftFinance(snapshot.finance_draft ? hydratedFinance : null);
        setDraftVersion(snapshot.finance_draft?.version ?? null);
        setReceipt(receiptFromReport(snapshot));
        setReportLoadState('success');
      } catch (error) {
        if (!active) return;
        if (codeFrom(error) === 'NOT_FOUND') {
          setReportSnapshot({ report: null, revision: null, finance: null, stock_lines: [], finance_draft: null });
          setFinance({ ...emptyFinance });
          setReportLoadState('success');
          return;
        }
        setReportLoadError(messageFrom(error, 'Laporan gagal dimuat.'));
        setReportLoadState('error');
      }
    };

    void loadReport();
    return () => {
      active = false;
    };
  }, [workDate]);

  useEffect(() => {
    let active = true;

    const loadManagerReports = async () => {
      setIsManager(false);
      setManagerLoadError('');
      setManagerLoadState('checking');
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
  const reportIsImmutable = Boolean(reportSnapshot?.report && !['DRAFT', 'NEEDS_CLARIFICATION'].includes(reportSnapshot.report.status));
  const receiptFields = receipt
    ? [
        receipt.report_id ? `ID laporan: ${receipt.report_id}` : '',
        receipt.revision_id ? `ID revisi: ${receipt.revision_id}` : '',
        receipt.public_id ? `ID publik: ${receipt.public_id}` : '',
        receipt.status ? `Status: ${receipt.status}` : '',
      ].filter(Boolean)
    : [];
  const canCopyReceipt = receiptFields.length > 0;
  const recipientIsValid = uuidPattern.test(recipientId.trim());
  const reasonIsValid = shareReason.trim().length > 0 && shareReason.trim().length <= 1000;
  const canShareReport = Boolean(isManager && reportSnapshot?.revision && reportSnapshot.report && recipientIsValid && reasonIsValid);
  const fieldsDisabled = reportLoadState !== 'success' || draftState === 'loading' || submitState === 'loading' || submitState === 'success' || reportIsImmutable || !isFinalizer;
  const submitDisabledReason = submitState === 'loading'
    ? 'Pengiriman sedang diproses oleh server.'
    : submitState === 'success'
      ? 'Laporan sudah terkirim. Receipt server tersedia di bawah.'
      : !isFinalizer
        ? 'Hanya primary BAR shift MALAM/FULL atau manajemen yang dapat mengirim laporan.'
        : reportLoadState === 'loading'
          ? 'Laporan server masih dimuat.'
          : reportLoadState === 'error'
            ? 'Laporan server gagal dimuat. Perbaiki kesalahan pemuatan sebelum mengirim.'
            : reportIsImmutable
              ? 'Laporan terkini sudah dikunci setelah dikirim.'
        : !financeIsValid
          ? 'Perbaiki semua nilai keuangan sebelum mengirim.'
          : '';

  const handleSaveDraft = async () => {
    if (!parsedFinance || !isFinalizer || reportLoadState !== 'success' || reportIsImmutable || draftInFlightRef.current) return;

    draftInFlightRef.current = true;
    draftIdempotencyKeyRef.current ??= crypto.randomUUID();
    setDraftState('loading');
    setDraftMessage('Menyimpan draft finance ke server...');
    try {
      const saved = await api.saveReportFinance(workDate, draftVersion, parsedFinance, draftIdempotencyKeyRef.current);
      setDraftVersion(saved.version);
      setServerDraftFinance(parsedFinance);
      setFinanceDirty(false);
      setReportSnapshot((current) => current ? {
        ...current,
        finance_draft: { ...(current.finance_draft ?? {}), ...saved, finance_json: parsedFinance },
      } as ReportSnapshot : current);
      setDraftState('success');
      setDraftMessage(`Draft finance tersimpan di server (versi ${saved.version}).`);
      draftIdempotencyKeyRef.current = null;
    } catch (error) {
      setDraftState('error');
      setDraftMessage(messageFrom(error, 'Draft finance gagal disimpan. Coba lagi untuk mengulang request yang sama.'));
    } finally {
      draftInFlightRef.current = false;
    }
  };

  const handleSubmitReport = async () => {
    if (!parsedFinance || !isFinalizer || reportLoadState !== 'success' || reportIsImmutable || submitState === 'loading' || submitState === 'success') return;

    const financeToSubmit = !financeDirty && serverDraftFinance ? serverDraftFinance : parsedFinance;

    setSubmitState('loading');
    setSubmitMessage('Mengirim finance dan meminta validasi kesiapan dari server...');
    setRefreshWarning('');
    setShareMessage('');

    let serverReceipt: ReportReceipt;
    try {
      serverReceipt = await api.submitReport(workDate, financeToSubmit) as ReportReceipt;
    } catch (error) {
      setSubmitState('error');
      setSubmitMessage(messageFrom(error, 'Laporan gagal dikirim. Data belum dinyatakan terkirim.'));
      return;
    }

    setReceipt(serverReceipt);
    setSubmitState('success');
    setSubmitMessage('Laporan diterima server. Simpan receipt berikut sebagai bukti pengiriman.');

    try {
      const snapshot = await api.getReport(workDate) as ReportSnapshot;
      const financeSource = financeFromSnapshot(snapshot);
      const hydratedFinance = financeSource === null ? null : parseServerFinance(financeSource);
      if (financeSource !== null && !hydratedFinance) throw new Error('Finance server tidak valid setelah submit.');
      setReportSnapshot(snapshot);
      setFinance(hydratedFinance ? financeToInputs(hydratedFinance) : financeToInputs(financeToSubmit));
      setServerDraftFinance(snapshot.finance_draft ? hydratedFinance : null);
      setFinanceDirty(false);
      setDraftVersion(snapshot.finance_draft?.version ?? null);
      setReportLoadError('');
      setReportLoadState('success');
      setReceipt({ ...serverReceipt, ...(receiptFromReport(snapshot) ?? {}) });
    } catch (error) {
      setRefreshWarning(`Laporan sudah terkirim, tetapi detail laporan gagal diperbarui: ${messageFrom(error, 'Muat ulang laporan.')}`);
    }

    try {
      await onRefresh();
    } catch (error) {
      setRefreshWarning((current) => `${current ? `${current} ` : ''}Workspace gagal diperbarui: ${messageFrom(error, 'Muat ulang workspace.')}`);
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

  const handleCopyReceipt = async () => {
    if (!canCopyReceipt || isManager) return;
    const text = receiptFields.join('\n');

    try {
      if (!navigator.clipboard) throw new Error('Clipboard tidak tersedia di browser ini.');
      await navigator.clipboard.writeText(text);
      setShareState('success');
      setShareMessage('Receipt server berhasil disalin.');
    } catch (error) {
      setShareState('error');
      setShareMessage(messageFrom(error, 'Receipt server gagal disalin. ID tetap tersedia di bawah.'));
    }
  };

  const handleShareReport = async () => {
    const report = reportSnapshot?.report;
    const revision = reportSnapshot?.revision;
    const reason = shareReason.trim();
    const recipient = recipientId.trim();
    if (!isManager || !report || !revision || !recipientIsValid || !reasonIsValid || shareInFlightRef.current) return;

    shareInFlightRef.current = true;
    shareIdempotencyKeyRef.current ??= crypto.randomUUID();
    setShareState('loading');
    setShareMessage('Membagikan revisi laporan melalui server...');
    try {
      const shared = await api.shareReport(revision.id, report.version, recipient, reason, shareIdempotencyKeyRef.current);
      setShareState('success');
      setShareMessage(shared.already_shared
        ? `Laporan sudah pernah dibagikan kepada penerima ini (ID ${shared.share_id}).`
        : `Laporan berhasil dibagikan melalui server (ID ${shared.share_id}).`);
      shareIdempotencyKeyRef.current = null;
    } catch (error) {
      setShareState('error');
      setShareMessage(messageFrom(error, 'Laporan gagal dibagikan. Coba lagi untuk mengulang request yang sama.'));
    } finally {
      shareInFlightRef.current = false;
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
          <strong>Kesiapan diperiksa saat submit.</strong> Server mewajibkan tepat satu closing terkonfirmasi dan lengkap untuk BAR serta KITCHEN. Pastikan antrean sinkronisasi perangkat kosong sebelum mengirim.
        </div>

        {reportLoadState === 'loading' && (
          <p role="status" style={{ margin: '12px 0 0', color: '#547066' }}>Memuat laporan dan draft finance dari server...</p>
        )}
        {reportLoadState === 'error' && (
          <div role="alert" className="form-error" style={{ margin: '12px 0 0' }}>
            Laporan tidak dapat dimuat: {reportLoadError}
          </div>
        )}

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
                      setFinanceDirty(true);
                      setDraftState('idle');
                      setDraftMessage('');
                      setSubmitState('idle');
                      setSubmitMessage('');
                      draftIdempotencyKeyRef.current = null;
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
              onClick={() => { void handleSaveDraft(); }}
              disabled={fieldsDisabled || !financeIsValid}
              style={{ width: '100%' }}
            >
              {draftState === 'loading' ? 'Menyimpan...' : 'Simpan Draft'}
            </button>

            <button
              type="submit"
              className="primary-button"
              disabled={Boolean(submitDisabledReason) || !financeIsValid || draftState === 'loading'}
              aria-describedby={submitDisabledReason ? 'submit-disabled-reason' : undefined}
              style={{ width: '100%' }}
            >
              {submitState === 'loading' ? 'Mengirim...' : submitState === 'success' ? 'Laporan Terkirim' : 'Kirim Laporan Resmi'}
            </button>
          </div>

          {submitDisabledReason && (
            <p id="submit-disabled-reason" style={{ margin: '6px 0 0', color: '#7d5b2b', fontSize: '11px' }}>
              Tombol kirim nonaktif: {submitDisabledReason}
            </p>
          )}
        </form>

        {draftState !== 'idle' && (
          <div
            role={draftState === 'error' ? 'alert' : 'status'}
            style={{ marginTop: '16px', padding: '12px', borderRadius: '10px', border: `1px solid ${draftState === 'error' ? '#e6b9b0' : '#c6dfd0'}`, background: draftState === 'error' ? '#fbe8e4' : '#e4f1e8', color: draftState === 'error' ? '#8f3f34' : '#1e5b48' }}
          >
            {draftMessage}
          </div>
        )}

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

        {isManager && reportSnapshot?.revision && reportSnapshot.report && (
          <section aria-labelledby="share-report-title" style={{ marginTop: '16px', padding: '16px', borderRadius: '10px', border: '1px solid #e0ece6', background: '#f8faf9' }}>
            <p className="eyebrow">AKSES LAPORAN</p>
            <h3 id="share-report-title">Bagikan Revisi Server</h3>
            <div style={{ display: 'grid', gap: '12px', marginTop: '12px' }}>
              <div>
                <label htmlFor="report-share-recipient" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>
                  UUID Penerima
                </label>
                <input
                  id="report-share-recipient"
                  value={recipientId}
                  required
                  aria-invalid={Boolean(recipientId) && !recipientIsValid}
                  onChange={(event) => {
                    setRecipientId(event.target.value);
                    setShareState('idle');
                    setShareMessage('');
                    shareIdempotencyKeyRef.current = null;
                  }}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  style={{ width: '100%', padding: '8px', borderRadius: '8px', border: recipientId && !recipientIsValid ? '1px solid #b95745' : '1px solid #cddcd4' }}
                />
                {recipientId && !recipientIsValid && <p style={{ margin: '4px 0 0', color: '#8f3f34', fontSize: '11px' }}>UUID penerima wajib valid.</p>}
              </div>
              <div>
                <label htmlFor="report-share-reason" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: '#6b8378', marginBottom: '4px' }}>
                  Alasan
                </label>
                <textarea
                  id="report-share-reason"
                  value={shareReason}
                  required
                  maxLength={1000}
                  aria-invalid={Boolean(shareReason) && !reasonIsValid}
                  onChange={(event) => {
                    setShareReason(event.target.value);
                    setShareState('idle');
                    setShareMessage('');
                    shareIdempotencyKeyRef.current = null;
                  }}
                  placeholder="Jelaskan tujuan pembagian laporan."
                  style={{ width: '100%', minHeight: '76px', padding: '8px', borderRadius: '8px', border: shareReason && !reasonIsValid ? '1px solid #b95745' : '1px solid #cddcd4', resize: 'vertical' }}
                />
                {shareReason && !reasonIsValid && <p style={{ margin: '4px 0 0', color: '#8f3f34', fontSize: '11px' }}>Alasan wajib berisi 1 sampai 1000 karakter.</p>}
              </div>
              <button
                type="button"
                className="outline-button"
                disabled={!canShareReport || shareState === 'loading'}
                onClick={() => { void handleShareReport(); }}
              >
                {shareState === 'loading' ? 'Membagikan...' : 'Bagikan Laporan'}
              </button>
            </div>
          </section>
        )}

        {managerLoadState === 'not-applicable' && receipt && (
          <button
            type="button"
            className="outline-button"
            disabled={!canCopyReceipt}
            onClick={() => { void handleCopyReceipt(); }}
            style={{ width: '100%', marginTop: '12px' }}
          >
            Salin Receipt
          </button>
        )}

        {shareMessage && (
          <p role={shareState === 'error' ? 'alert' : 'status'} style={{ margin: '10px 0 0', color: shareState === 'error' ? '#8f3f34' : '#547066' }}>
            {shareMessage}
          </p>
        )}
      </section>
    </div>
  );
}

import { useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../../lib/api';

type Props = {
  onComplete: () => void;
};

type OpeningChoice = 'MATCHED' | 'ZERO' | 'CUSTOM' | null;
type MovementState = 'EMPTY' | 'RECORDED' | 'CORRECTED';
type QueueState = 'ONLINE' | 'QUEUED' | 'CONFLICT' | 'RESOLVED';

const steps = [
  { title: 'Penugasan & roster', short: 'Penugasan' },
  { title: 'Check-in & GPS', short: 'Check-in' },
  { title: 'Primary vs Helper', short: 'Peran' },
  { title: 'Hitung opening', short: 'Opening' },
  { title: 'Pergerakan & koreksi', short: 'Stok' },
  { title: 'Handover atau closing', short: 'Penutupan' },
  { title: 'Antrean offline & konflik', short: 'Sinkronisasi' },
  { title: 'Check-out & Bantuan', short: 'Selesai' },
] as const;

const colors = {
  forest: '#123d32',
  green: '#1e5b48',
  ink: '#17352d',
  muted: '#547066',
  line: '#d8e4dd',
  mint: '#e6f2eb',
  cream: '#fbfaf5',
  amber: '#fff3db',
  amberInk: '#7d5b2b',
  red: '#8f3f34',
  redBg: '#fbe8e4',
};

const styles: Record<string, CSSProperties> = {
  page: { alignItems: 'stretch', minHeight: '100vh' },
  panel: {
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    maxWidth: '760px',
    minHeight: '100vh',
    margin: '0 auto',
    padding: 'clamp(22px, 5vw, 52px) clamp(16px, 5vw, 44px)',
    textAlign: 'left',
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' },
  brand: { margin: 0, justifyContent: 'flex-start', textAlign: 'left' },
  trainingBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '30px',
    border: '1px solid #d7b87d',
    borderRadius: '999px',
    background: colors.amber,
    color: colors.amberInk,
    padding: '5px 10px',
    fontFamily: "'DM Mono', monospace",
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '.1em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  },
  intro: { marginTop: '28px' },
  eyebrow: {
    margin: '0 0 7px',
    color: '#789087',
    fontFamily: "'DM Mono', monospace",
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '.12em',
    textTransform: 'uppercase',
  },
  title: { margin: 0, color: colors.forest, fontSize: 'clamp(25px, 5vw, 34px)', lineHeight: 1.08 },
  description: { maxWidth: '590px', margin: '9px 0 0', color: colors.muted, fontSize: '13px', lineHeight: 1.6 },
  progressTrack: {
    display: 'grid',
    gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
    gap: '5px',
    marginTop: '22px',
  },
  progressSegment: { height: '6px', borderRadius: '99px' },
  card: {
    minHeight: '360px',
    marginTop: '20px',
    border: `1px solid ${colors.line}`,
    borderRadius: '18px',
    background: colors.cream,
    padding: 'clamp(18px, 4vw, 30px)',
    boxShadow: '0 14px 35px rgba(29,63,51,.07)',
  },
  simulationLabel: {
    display: 'inline-block',
    marginBottom: '12px',
    color: colors.green,
    fontFamily: "'DM Mono', monospace",
    fontSize: '9px',
    fontWeight: 700,
    letterSpacing: '.14em',
    textTransform: 'uppercase',
  },
  stepTitle: { margin: '0 0 8px', color: colors.forest, fontSize: '22px', lineHeight: 1.2 },
  copy: { margin: '0 0 18px', color: colors.muted, fontSize: '13px', lineHeight: 1.58 },
  choiceGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: '9px' },
  choice: {
    minHeight: '58px',
    border: `1px solid ${colors.line}`,
    borderRadius: '11px',
    background: '#fff',
    color: colors.ink,
    padding: '11px 12px',
    textAlign: 'left',
  },
  choiceSelected: { borderColor: colors.green, background: colors.mint, boxShadow: '0 0 0 2px rgba(30,91,72,.09)' },
  result: {
    marginTop: '14px',
    borderLeft: `3px solid ${colors.green}`,
    borderRadius: '7px',
    background: colors.mint,
    color: colors.forest,
    padding: '11px 12px',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  warning: {
    marginTop: '14px',
    borderLeft: '3px solid #c98732',
    borderRadius: '7px',
    background: colors.amber,
    color: colors.amberInk,
    padding: '11px 12px',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  miniCard: { border: `1px solid ${colors.line}`, borderRadius: '11px', background: '#fff', padding: '13px' },
  miniLabel: {
    display: 'block',
    marginBottom: '5px',
    color: '#789087',
    fontFamily: "'DM Mono', monospace",
    fontSize: '9px',
    letterSpacing: '.08em',
    textTransform: 'uppercase',
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '14px' },
  smallButton: { width: 'auto', minHeight: '42px', margin: 0, padding: '9px 13px' },
  nav: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    marginTop: '18px',
  },
  navButton: { width: 'auto', minWidth: '112px', minHeight: '46px', margin: 0 },
  error: {
    marginTop: '14px',
    border: '1px solid #e7bcb4',
    borderRadius: '10px',
    background: colors.redBg,
    color: colors.red,
    padding: '12px',
    fontSize: '12px',
    lineHeight: 1.5,
  },
};

function ChoiceButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      style={{ ...styles.choice, ...(selected ? styles.choiceSelected : {}) }}
    >
      {children}
    </button>
  );
}

export function StaffOnboarding({ onComplete }: Props) {
  const [currentStep, setCurrentStep] = useState(0);
  const [assignment, setAssignment] = useState<'BAR' | 'KITCHEN'>('BAR');
  const [gpsStatus, setGpsStatus] = useState<'IDLE' | 'INSIDE' | 'REVIEW'>('IDLE');
  const [role, setRole] = useState<'PRIMARY' | 'HELPER'>('PRIMARY');
  const [openingChoice, setOpeningChoice] = useState<OpeningChoice>(null);
  const [customQuantity, setCustomQuantity] = useState('');
  const [movementState, setMovementState] = useState<MovementState>('EMPTY');
  const [closingAction, setClosingAction] = useState<'HANDOVER' | 'CLOSING' | null>(null);
  const [queueState, setQueueState] = useState<QueueState>('ONLINE');
  const [checkedOut, setCheckedOut] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [completionError, setCompletionError] = useState<string | null>(null);

  const isLastStep = currentStep === steps.length - 1;

  const goToStep = (nextStep: number) => {
    setCompletionError(null);
    setCurrentStep(Math.max(0, Math.min(nextStep, steps.length - 1)));
  };

  const replayHelp = () => {
    setGpsStatus('IDLE');
    setOpeningChoice(null);
    setCustomQuantity('');
    setMovementState('EMPTY');
    setClosingAction(null);
    setQueueState('ONLINE');
    setCheckedOut(false);
    goToStep(0);
  };

  const handleFinish = async () => {
    if (submitting) return;
    setSubmitting(true);
    setCompletionError(null);
    try {
      await api.completeOnboarding(2);
      onComplete();
    } catch {
      setCompletionError('Progres latihan belum dapat disimpan. Anda tetap di langkah ini; periksa koneksi lalu coba lagi.');
    } finally {
      setSubmitting(false);
    }
  };

  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return (
          <>
            <span style={styles.simulationLabel}>Latihan 01 / Penugasan lokal</span>
            <h2 id="onboarding-step-title" style={styles.stepTitle}>Baca roster, lalu pilih area</h2>
            <p style={styles.copy}>Roster menentukan shift dan area kerja. Pada latihan ini Anda dijadwalkan Shift Siang, 10.00-18.00. Pilihan di bawah tidak mengubah roster asli.</p>
            <div style={styles.choiceGrid} aria-label="Pilih area latihan">
              <ChoiceButton selected={assignment === 'BAR'} onClick={() => setAssignment('BAR')}>
                <strong>Bar</strong><br /><small>Shift Siang · 10.00-18.00</small>
              </ChoiceButton>
              <ChoiceButton selected={assignment === 'KITCHEN'} onClick={() => setAssignment('KITCHEN')}>
                <strong>Kitchen</strong><br /><small>Shift Siang · 10.00-18.00</small>
              </ChoiceButton>
            </div>
            <div style={styles.result} role="status">Penugasan latihan: <strong>{assignment}</strong>, Shift Siang. Pastikan pilihan sesuai roster sebelum check-in.</div>
          </>
        );
      case 1:
        return (
          <>
            <span style={styles.simulationLabel}>Latihan 02 / Tanpa akses GPS</span>
            <h2 id="onboarding-step-title" style={styles.stepTitle}>Check-in memeriksa lokasi</h2>
            <p style={styles.copy}>Saat bekerja, HOPIN meminta izin lokasi dan memeriksa radius outlet. Latihan ini tidak membaca atau menyimpan lokasi perangkat Anda.</p>
            <div style={styles.actions}>
              <button type="button" className="primary-button" style={styles.smallButton} onClick={() => setGpsStatus('INSIDE')}>Simulasikan dalam radius</button>
              <button type="button" className="outline-button" style={styles.smallButton} onClick={() => setGpsStatus('REVIEW')}>Simulasikan GPS bermasalah</button>
            </div>
            {gpsStatus === 'INSIDE' && <div style={styles.result} role="status"><strong>Check-in diterima.</strong> Lokasi memenuhi radius dan akurasi outlet.</div>}
            {gpsStatus === 'REVIEW' && <div style={styles.warning} role="status"><strong>Perlu ditinjau.</strong> Jelaskan kendala GPS dengan catatan yang jujur. Jangan mengarang lokasi.</div>}
          </>
        );
      case 2:
        return (
          <>
            <span style={styles.simulationLabel}>Latihan 03 / Batas kewenangan</span>
            <h2 id="onboarding-step-title" style={styles.stepTitle}>Primary mengonfirmasi, Helper membantu</h2>
            <p style={styles.copy}>Satu area hanya memiliki satu Primary. Helper boleh menghitung dan menyimpan draft, tetapi tidak boleh memberi konfirmasi akhir.</p>
            <div style={styles.choiceGrid} aria-label="Bandingkan peran latihan">
              <ChoiceButton selected={role === 'PRIMARY'} onClick={() => setRole('PRIMARY')}>
                <strong>Primary</strong><br /><small>Hitung, koreksi, dan konfirmasi akhir</small>
              </ChoiceButton>
              <ChoiceButton selected={role === 'HELPER'} onClick={() => setRole('HELPER')}>
                <strong>Helper</strong><br /><small>Hitung dan simpan draft untuk Primary</small>
              </ChoiceButton>
            </div>
            <div style={role === 'PRIMARY' ? styles.result : styles.warning} role="status">
              {role === 'PRIMARY' ? 'Anda bertanggung jawab memeriksa bukti sebelum konfirmasi.' : 'Serahkan draft kepada Primary. Tombol konfirmasi akhir tidak tersedia untuk Helper.'}
            </div>
          </>
        );
      case 3:
        return (
          <>
            <span style={styles.simulationLabel}>Latihan 04 / Hitung fisik</span>
            <h2 id="onboarding-step-title" style={styles.stepTitle}>Opening harus dihitung secara eksplisit</h2>
            <p style={styles.copy}>Patokan sistem bukan hasil hitung fisik. Setelah benar-benar menghitung, pilih satu tindakan untuk setiap barang. Kolom kosong tetap berarti belum dihitung.</p>
            <div style={styles.miniCard}>
              <span style={styles.miniLabel}>Sirup Gula · Patokan 12 botol</span>
              <strong>Berapa hasil fisiknya?</strong>
              <div style={styles.actions}>
                <button type="button" className="outline-button" aria-pressed={openingChoice === 'MATCHED'} style={styles.smallButton} onClick={() => setOpeningChoice('MATCHED')}>Sesuai (12)</button>
                <button type="button" className="outline-button" aria-pressed={openingChoice === 'ZERO'} style={styles.smallButton} onClick={() => setOpeningChoice('ZERO')}>0</button>
                <button type="button" className="outline-button" aria-pressed={openingChoice === 'CUSTOM'} style={styles.smallButton} onClick={() => setOpeningChoice('CUSTOM')}>Ubah jumlah</button>
              </div>
              {openingChoice === 'CUSTOM' && (
                <label style={{ display: 'block', marginTop: '12px', color: colors.muted, fontSize: '11px', fontWeight: 700 }}>
                  Jumlah fisik
                  <input inputMode="decimal" value={customQuantity} onChange={(event) => setCustomQuantity(event.target.value)} placeholder="Contoh: 10" style={{ maxWidth: '180px' }} />
                </label>
              )}
            </div>
            {openingChoice && <div style={styles.result} role="status">Hasil latihan tercatat: <strong>{openingChoice === 'MATCHED' ? '12' : openingChoice === 'ZERO' ? '0' : customQuantity || 'masukkan jumlah'}</strong>. Jika berbeda dari patokan, kategori alasan wajib; catatan tambahan opsional.</div>}
          </>
        );
      case 4:
        return (
          <>
            <span style={styles.simulationLabel}>Latihan 05 / Buku stok lokal</span>
            <h2 id="onboarding-step-title" style={styles.stepTitle}>Catat pergerakan, jangan menghapus kesalahan</h2>
            <p style={styles.copy}>Barang masuk dan keluar dicatat saat terjadi. Jika salah, buat koreksi yang tertaut agar jejak perubahan tetap dapat diaudit.</p>
            <div style={styles.miniCard}>
              <span style={styles.miniLabel}>Sirup Gula · Keluar</span>
              <strong>{movementState === 'EMPTY' ? 'Belum ada catatan' : movementState === 'RECORDED' ? 'Tercatat 5 botol' : 'Dikoreksi menjadi 2 botol'}</strong>
              <div style={styles.actions}>
                <button type="button" className="primary-button" style={styles.smallButton} onClick={() => setMovementState('RECORDED')} disabled={movementState !== 'EMPTY'}>Catat keluar 5</button>
                <button type="button" className="outline-button" style={styles.smallButton} onClick={() => setMovementState('CORRECTED')} disabled={movementState !== 'RECORDED'}>Koreksi menjadi 2</button>
              </div>
            </div>
            {movementState === 'RECORDED' && <div style={styles.warning} role="status">Angka salah? Gunakan Koreksi, bukan membuat transaksi lawan atau menghapus catatan.</div>}
            {movementState === 'CORRECTED' && <div style={styles.result} role="status">Koreksi tertaut ke catatan awal. Riwayat 5 menjadi 2 tetap terlihat.</div>}
          </>
        );
      case 5:
        return (
          <>
            <span style={styles.simulationLabel}>Latihan 06 / Akhir shift</span>
            <h2 id="onboarding-step-title" style={styles.stepTitle}>Pilih handover atau closing yang tepat</h2>
            <p style={styles.copy}>Shift Siang menyerahkan stok ke Shift Malam melalui handover. Shift Malam atau Full melakukan hitung fisik closing. Primary memeriksa antrean sebelum mengakhiri siklus.</p>
            <div style={styles.choiceGrid} aria-label="Pilih alur akhir shift latihan">
              <ChoiceButton selected={closingAction === 'HANDOVER'} onClick={() => setClosingAction('HANDOVER')}>
                <strong>Handover</strong><br /><small>Siang menyerahkan ke Malam</small>
              </ChoiceButton>
              <ChoiceButton selected={closingAction === 'CLOSING'} onClick={() => setClosingAction('CLOSING')}>
                <strong>Closing</strong><br /><small>Malam / Full menghitung akhir</small>
              </ChoiceButton>
            </div>
            {closingAction && <div style={styles.result} role="status">{closingAction === 'HANDOVER' ? 'Stok terkonfirmasi menjadi referensi opening Shift Malam.' : 'Hitung setiap barang secara eksplisit; selisih memerlukan kategori alasan.'}</div>}
          </>
        );
      case 6:
        return (
          <>
            <span style={styles.simulationLabel}>Latihan 07 / Sinkronisasi lokal</span>
            <h2 id="onboarding-step-title" style={styles.stepTitle}>Offline masuk antrean, konflik perlu keputusan</h2>
            <p style={styles.copy}>Saat koneksi terputus, tindakan yang didukung disimpan sebagai antrean. Jangan masukkan ulang. Setelah online, periksa status sinkronisasi dan selesaikan konflik yang tetap terlihat.</p>
            <div style={styles.miniCard}>
              <span style={styles.miniLabel}>Pusat sinkronisasi</span>
              <strong>{queueState === 'ONLINE' ? 'Online · antrean kosong' : queueState === 'QUEUED' ? 'Offline · 1 menunggu' : queueState === 'CONFLICT' ? 'Konflik versi ditemukan' : 'Konflik diselesaikan'}</strong>
              <div style={styles.actions}>
                <button type="button" className="primary-button" style={styles.smallButton} onClick={() => setQueueState('QUEUED')} disabled={queueState !== 'ONLINE'}>Simulasikan offline</button>
                <button type="button" className="outline-button" style={styles.smallButton} onClick={() => setQueueState('CONFLICT')} disabled={queueState !== 'QUEUED'}>Sambungkan kembali</button>
                <button type="button" className="outline-button" style={styles.smallButton} onClick={() => setQueueState('RESOLVED')} disabled={queueState !== 'CONFLICT'}>Tinjau & selesaikan</button>
              </div>
            </div>
            {queueState === 'QUEUED' && <div style={styles.warning} role="status">Menunggu sinkronisasi. Jangan membuat catatan yang sama untuk kedua kali.</div>}
            {queueState === 'CONFLICT' && <div style={{ ...styles.error, marginBottom: 0 }} role="alert">Data server berubah lebih dahulu. Konflik tidak dibuang otomatis; tinjau sebelum memilih hasil.</div>}
            {queueState === 'RESOLVED' && <div style={styles.result} role="status">Antrean bersih dan keputusan konflik tercatat.</div>}
          </>
        );
      default:
        return (
          <>
            <span style={styles.simulationLabel}>Latihan 08 / Penutupan pribadi</span>
            <h2 id="onboarding-step-title" style={styles.stepTitle}>Check-out setelah tugas selesai</h2>
            <p style={styles.copy}>Pastikan handover atau closing, antrean, dan tugas tertunda sudah diperiksa. Check-out menggunakan pemeriksaan GPS yang sama dan tidak menggantikan penyelesaian tugas.</p>
            <div style={styles.actions}>
              <button type="button" className="primary-button" style={styles.smallButton} onClick={() => setCheckedOut(true)} disabled={checkedOut}>{checkedOut ? 'Check-out latihan berhasil' : 'Simulasikan check-out'}</button>
              <button type="button" className="outline-button" style={styles.smallButton} onClick={replayHelp}>Ulangi panduan Bantuan</button>
            </div>
            <div style={checkedOut ? styles.result : styles.warning} role="status">
              {checkedOut ? 'Shift latihan selesai. Simpan progres untuk mulai menggunakan HOPIN.' : 'Jika ada masalah atau tugas tertunda, buka Bantuan dan hubungi Primary atau Supervisor. Check-out darurat akan ditinjau.'}
            </div>
            {completionError && (
              <div style={styles.error} role="alert">
                <strong>Gagal menyimpan progres.</strong><br />{completionError}
                <div>
                  <button type="button" className="outline-button" style={{ ...styles.smallButton, marginTop: '10px' }} onClick={() => void handleFinish()} disabled={submitting}>
                    {submitting ? 'Mencoba lagi...' : 'Coba lagi'}
                  </button>
                </div>
              </div>
            )}
          </>
        );
    }
  };

  return (
    <div className="login-page" style={styles.page}>
      <main className="login-panel" style={styles.panel} aria-labelledby="onboarding-title">
        <header style={styles.header}>
          <div className="login-brand" style={styles.brand}>
            <div><strong style={{ fontSize: '24px' }}>HOPIN</strong><small>PANDUAN OPERATOR</small></div>
          </div>
          <span style={styles.trainingBadge}>Latihan · Aman</span>
        </header>

        <div style={styles.intro}>
          <p style={styles.eyebrow}>Langkah {currentStep + 1} dari {steps.length} · {steps[currentStep].short}</p>
          <h1 id="onboarding-title" style={styles.title}>Latihan alur shift</h1>
          <p style={styles.description}>Semua pilihan dalam panduan ini hanya simulasi lokal. Tidak ada absensi, lokasi, roster, atau stok produksi yang diubah.</p>
        </div>

        <div
          role="progressbar"
          aria-label={`Progres onboarding: langkah ${currentStep + 1} dari ${steps.length}`}
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-valuenow={currentStep + 1}
          aria-valuetext={`${steps[currentStep].title}, langkah ${currentStep + 1} dari ${steps.length}`}
          style={styles.progressTrack}
        >
          {steps.map((step, index) => (
            <span
              key={step.title}
              aria-hidden="true"
              style={{ ...styles.progressSegment, background: index <= currentStep ? colors.green : '#dfe7e2' }}
            />
          ))}
        </div>

        <section style={styles.card} aria-labelledby="onboarding-step-title">
          {renderStep()}
        </section>

        <nav aria-label="Navigasi onboarding" style={styles.nav}>
          <button
            type="button"
            className="outline-button"
            style={styles.navButton}
            onClick={() => goToStep(currentStep - 1)}
            disabled={currentStep === 0 || submitting}
          >
            Kembali
          </button>
          {!isLastStep ? (
            <button type="button" className="primary-button" style={styles.navButton} onClick={() => goToStep(currentStep + 1)}>
              Berikutnya
            </button>
          ) : !completionError ? (
            <button type="button" className="primary-button" style={styles.navButton} onClick={() => void handleFinish()} disabled={submitting}>
              {submitting ? 'Menyimpan...' : 'Simpan & mulai bekerja'}
            </button>
          ) : <span aria-hidden="true" />}
        </nav>
      </main>
    </div>
  );
}

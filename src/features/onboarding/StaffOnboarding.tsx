import { useState } from 'react';
import { api } from '../../lib/api';

type Props = {
  onComplete: () => void;
};

const steps = [
  {
    title: '1. Pemilihan Shift & Area',
    desc: 'Pilih Shift (Siang/Malam/Full) dan Area (Bar/Kitchen). Hanya 1 orang menjadi Penanggung Jawab Utama per area, yang lainnya bergabung sebagai Bantuan.',
  },
  {
    title: '2. Absensi Swipe & GPS',
    desc: 'Lakukan absensi dengan swipe layar. Lokasi GPS akan diperiksa dalam radius 100m dari cafe. Jika GPS terkendala, isi catatan alasan agar dapat ditinjau.',
  },
  {
    title: '3. Konfirmasi Stok Awal',
    desc: 'Hitung fisik bahan baku sebelum memulai shift. Jika ada selisih dari sistem, isi alasan dan catatan sebelum konfirmasi.',
  },
  {
    title: '4. Catat Perubahan Stok',
    desc: 'Setiap barang masuk (pembelian) atau keluar (pemakaian), catat langsung pada aplikasi agar saldo stok selalu akurat.',
  },
  {
    title: '5. Handover & Closing Akhir',
    desc: 'Shift Siang melakukan handover sistem ke Shift Malam. Shift Malam melakukan hitung fisik closing dan kirim laporan harian.',
  },
];

export function StaffOnboarding({ onComplete }: Props) {
  const [currentStep, setCurrentStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const handleNext = async () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      setSubmitting(true);
      try {
        await api.completeOnboarding(1);
      } catch (e) {
        console.error(e);
      } finally {
        setSubmitting(false);
        onComplete();
      }
    }
  };

  return (
    <div className="login-page">
      <div className="login-panel" style={{ maxWidth: '480px' }}>
        <div className="login-brand">
          <div><strong>HOPIN</strong><small>PANDUAN OPERATOR</small></div>
        </div>

        <div className="onboarding-step-card" style={{ marginTop: '20px' }}>
          <span
            style={{
              display: 'inline-block',
              background: '#e0ece6',
              color: '#1e5b48',
              fontSize: '11px',
              fontWeight: 700,
              padding: '4px 10px',
              borderRadius: '20px',
              letterSpacing: '0.06em',
              marginBottom: '12px',
            }}
          >
            LANGKAH {currentStep + 1} DARI {steps.length}
          </span>
          <h2 style={{ fontSize: '22px', color: '#123d32', margin: '0 0 10px', lineHeight: '1.25' }}>
            {steps[currentStep].title}
          </h2>
          <p style={{ fontSize: '14px', lineHeight: '1.6', color: '#4a6b5d', margin: 0 }}>
            {steps[currentStep].desc}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '6px', margin: '24px 0' }}>
          {steps.map((_, idx) => (
            <div
              key={idx}
              style={{
                flex: 1,
                height: '6px',
                borderRadius: '3px',
                background: idx <= currentStep ? '#1e5b48' : '#e0e7e4',
              }}
            />
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {currentStep > 0 ? (
            <button
              type="button"
              className="outline-button"
              onClick={() => setCurrentStep(currentStep - 1)}
            >
              Sebelumnya
            </button>
          ) : <div />}

          <button
            type="button"
            className="primary-button"
            onClick={handleNext}
            disabled={submitting}
          >
            {currentStep === steps.length - 1 ? 'Mulai Bekerja →' : 'Lanjut →'}
          </button>
        </div>
      </div>
    </div>
  );
}

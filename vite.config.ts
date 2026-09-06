import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Production CSP correctly blocks Vite's inline React Refresh preamble when
// Vercel serves the local dev app. Normal `pnpm dev` keeps Fast Refresh.
export default defineConfig({
  plugins: [react()],
  server: process.env.VERCEL ? { hmr: false } : undefined,
});

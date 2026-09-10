import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

function buildInfoPlugin(): Plugin {
  return {
    name: 'hopin-build-info',
    generateBundle() {
      const commit = (
        process.env.HOPIN_BUILD_SHA
        ?? process.env.GITHUB_SHA
        ?? process.env.VERCEL_GIT_COMMIT_SHA
        ?? 'local'
      ).trim();
      const environment = (
        process.env.VERCEL_ENV
        ?? (process.env.CI ? 'ci' : 'local')
      ).trim();

      this.emitFile({
        type: 'asset',
        fileName: 'build-info.json',
        source: JSON.stringify({
          commit,
          environment,
          builtAt: new Date().toISOString(),
        }, null, 2),
      });
    },
  };
}

// Production CSP correctly blocks Vite's inline React Refresh preamble when
// Vercel serves the local dev app. Normal `pnpm dev` keeps Fast Refresh.
export default defineConfig({
  plugins: [react(), buildInfoPlugin()],
  server: process.env.VERCEL ? { hmr: false } : undefined,
});

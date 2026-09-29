import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const backend = process.env.PB_URL ?? 'http://127.0.0.1:8090';

// Proxy settings shared by the dev server and `vite preview`: the SPA talks to
// PocketBase on the same origin (REST under /api, realtime SSE under
// /api/realtime, dashboard under /_/).
const proxy = {
  '/api': { target: backend, changeOrigin: true, ws: true },
  '^/_(/.*)?$': { target: backend, changeOrigin: true, ws: true },
};

// Production CSP: everything must come from our own origin (LAN without
// internet, no CDNs). 'wasm-unsafe-eval' is needed for the QR scanner WASM,
// inline styles for style attributes and the toast library's <style> tag.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'getraenkeliste:csp',
    apply: 'build',
    // right after <meta charset>, before any script/style tags
    transformIndexHtml: (html) =>
      html.replace(
        /(<meta charset="UTF-8" \/>)/,
        `$1\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`,
      ),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  server: {
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rolldownOptions: {
      output: {
        // Stable vendor chunks (better caching); scanner/QR libs stay lazy.
        codeSplitting: {
          groups: [
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|cookie|set-cookie-parser)[\\/]/ },
            { name: 'vendor', test: /[\\/]node_modules[\\/](@tanstack|pocketbase|sonner)[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    env: { TZ: 'Europe/Vienna' },
    css: false,
  },
});

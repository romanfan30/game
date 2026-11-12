import { defineConfig } from 'vite';

// Сервер слушает 0.0.0.0 и принимает любой host (превью песочницы: https://{port}-{sandbox}.e2b.app)
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});

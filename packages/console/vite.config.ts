import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.FACTORY_CONTROL_PLANE_URL || 'http://127.0.0.1:8088',
        changeOrigin: true,
      },
      '/healthz': {
        target: process.env.FACTORY_CONTROL_PLANE_URL || 'http://127.0.0.1:8088',
        changeOrigin: true,
      },
    },
  },
});

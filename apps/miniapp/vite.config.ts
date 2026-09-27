import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Общие схемы и типы берём из исходников: одна правда для фронта и бэка.
      '@dominify/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: { port: 5173, host: true },
  build: {
    target: 'es2020',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
});

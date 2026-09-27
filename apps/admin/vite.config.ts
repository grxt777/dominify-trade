import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@dominify/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts') },
  },
  server: { port: 5174, host: true },
  build: { target: 'es2020', sourcemap: true },
});

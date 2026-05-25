import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev proxy targets the Hono server. The port matches the server's default
// (3000); override `PORT` in `.env` if you change it for local dev.
const SERVER_PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

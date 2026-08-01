import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 3001 is the API running bare-metal; the Docker stack publishes it on 8080
 * instead, so this has to be overridable to develop the UI against a running
 * container rather than a second API process.
 */
const API_DEV_URL = process.env.API_DEV_URL ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': API_DEV_URL,
    },
  },
});

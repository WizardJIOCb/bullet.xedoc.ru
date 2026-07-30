import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
      },
      '/multiplayer': {
        target: 'http://127.0.0.1:8787',
        ws: true,
      },
      '/online-health': {
        target: 'http://127.0.0.1:8787',
        rewrite: () => '/health',
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});

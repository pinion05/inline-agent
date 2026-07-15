import { defineConfig } from 'astro/config';
import solid from '@astrojs/solid-js';

export default defineConfig({
  integrations: [solid()],
  server: {
    host: true,
  },
  vite: {
    server: {
      proxy: {
        '/events': 'http://localhost:7878',
      },
    },
  },
});

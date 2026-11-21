import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The tool lives at /app/ (one address with the marketing site: scripts/local.mjs). Its API stays at /api on the same origin,
// so the session cookie (Path=/) reaches both; API calls go through src/api/base.js API_BASE.

/**
 * A proxy to the API that tells it the address the browser used. Vite's short form rewrites Host to 127.0.0.1:4000, and a
 * preview's content policy names the address it is served from (previewRoute.js reads X-Forwarded-Host): without this, a page
 * opened on :5173 may load styles, scripts and fonts only from :4000, so the browser refuses every one of them.
 */
const toApi = {
  target: 'http://127.0.0.1:4000',
  changeOrigin: true,
  configure: (proxy) => proxy.on('proxyReq', (proxyReq, req) => {
    if (req.headers.host) proxyReq.setHeader('X-Forwarded-Host', req.headers.host);
    proxyReq.setHeader('X-Forwarded-Proto', 'http');
  }),
};

export default defineConfig({
  base: '/app/',
  plugins: [
    react(),
    {
      // Opened directly on :5173 (npm run dev, accounts off): / leads to the tool instead of Vite's "did you mean /app/" page.
      name: 'sas-root-to-app',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/' || req.url === '/app') {
            res.statusCode = 302;
            res.setHeader('Location', '/app/');
            return res.end();
          }
          next();
        });
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The API keeps its /api prefix (not /app/api): the same path the marketing site's sign-in form posts to.
      '/api': 'http://127.0.0.1:4000',
      // The previews of copies: served by the API under the app's own address (server/src/recreate/previewRoute.js).
      '/preview': toApi,
      // Built sites shared with a link (Build mode's "Publish"): served by the API the same way (server/src/buildmode/publish.js).
      '/sites': toApi,
    },
  },
});

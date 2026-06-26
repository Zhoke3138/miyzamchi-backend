import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

// ── MPA: два HTML-входа ─────────────────────────────────────────────────────
//  • index.html     — редирект на /workspace.html (landing временно отключён)
//  • workspace.html — единственный живой экран: Auth → Paywall → Legal Workspace
//
// chat.html (legacy script.js чат) убран из сборки — будет на отдельном домене.
// ИЗОЛЯЦИЯ TAILWIND: @tailwindcss/vite раскрывает preflight ТОЛЬКО там, где CSS
// делает `@import "tailwindcss"` — только src/landing.css. workspace.html
// использует своё отдельное CSS — Tailwind в него не подмешивается.

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    entries: ['workspace.html']
  },
  build: {
    rollupOptions: {
      input: {
        home:      resolve(__dirname, 'index.html'),      // жёсткий редирект → /workspace.html
        workspace: resolve(__dirname, 'workspace.html')   // единственный живой экран
      }
    }
  }
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync } from 'fs';

// ── MPA: два HTML-входа ─────────────────────────────────────────────────────
//  • index.html      — лендинг: оригинальный чат ChatMZ (верстка + style-ChatMZ.css
//                      + легаси script.js). Главная страница по умолчанию.
//  • workspace.html  — профессиональный Legal Workspace (React/SuperDoc, src/App.jsx).
//
// Лендинг ссылается на /script.js и /style-ChatMZ.css как на ОБЫЧНЫЕ статические
// файлы: script.js — классический (не модуль) легаси-скрипт чата, Vite его
// сознательно НЕ бандлит (менять его исполнение нельзя, см. CLAUDE.md).
// Файлы живут в корне (single source of truth) — плагин кладёт их в dist/ как есть.
const copyChatAssets = () => ({
  name: 'copy-chat-assets',
  closeBundle() {
    copyFileSync(resolve(__dirname, 'script.js'), resolve(__dirname, 'dist/script.js'));
    copyFileSync(resolve(__dirname, 'style-ChatMZ.css'), resolve(__dirname, 'dist/style-ChatMZ.css'));
  }
});

export default defineConfig({
  plugins: [react(), copyChatAssets()],
  optimizeDeps: {
    entries: ['workspace.html']
  },
  build: {
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        workspace: resolve(__dirname, 'workspace.html')
      }
    }
  }
});

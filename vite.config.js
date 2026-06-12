import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { copyFileSync } from 'fs';

// ── MPA: три HTML-входа ─────────────────────────────────────────────────────
//  • index.html      — ПРЕМИУМ-ЛЕНДИНГ (React + Tailwind + framer-motion,
//                      src/landing-main.jsx). Главная страница по умолчанию.
//  • chat.html       — базовый чат ChatMZ (верстка + style-ChatMZ.css + легаси
//                      script.js). Кнопка-портал лендинга ведёт сюда.
//  • workspace.html  — профессиональный Legal Workspace (React/SuperDoc, src/App.jsx).
//
// ИЗОЛЯЦИЯ TAILWIND: @tailwindcss/vite раскрывает preflight ТОЛЬКО там, где CSS
// делает `@import "tailwindcss"` — это лишь src/landing.css (бандл лендинга).
// chat.html и workspace.html — отдельные входы со своими CSS, Tailwind в них не
// подмешивается. Поэтому reset Tailwind не конфликтует с «чистым» CSS чата.
//
// script.js — классический (не модуль) легаси-скрипт чата, Vite его не бандлит;
// вместе со style-ChatMZ.css он копируется в dist как есть.
const copyChatAssets = () => ({
  name: 'copy-chat-assets',
  closeBundle() {
    copyFileSync(resolve(__dirname, 'script.js'), resolve(__dirname, 'dist/script.js'));
    copyFileSync(resolve(__dirname, 'style-ChatMZ.css'), resolve(__dirname, 'dist/style-ChatMZ.css'));
  }
});

export default defineConfig({
  plugins: [react(), tailwindcss(), copyChatAssets()],
  optimizeDeps: {
    entries: ['index.html', 'workspace.html']
  },
  build: {
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        chat: resolve(__dirname, 'chat.html'),
        workspace: resolve(__dirname, 'workspace.html')
      }
    }
  }
});

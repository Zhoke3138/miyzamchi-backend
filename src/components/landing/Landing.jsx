import React from 'react';
import { motion } from 'framer-motion';
import { AuroraBackground } from './AuroraBackground';
import { TextReveal } from './TextReveal';
import { ShimmerButton } from './ShimmerButton';
import { BentoGrid } from './BentoGrid';

// Премиум-лендинг (Aceternity/Magic UI). Точка входа index.html (/).
// Кнопка-портал ведёт в базовый чат (/chat.html).
export default function Landing() {
  return (
    <AuroraBackground>
      {/* Навбар */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-3">
          <img src="/logo/Logo_transparent.png?v=2" alt="Miyzamchi" className="h-9 w-9" />
          <span className="text-lg font-semibold tracking-tight">Miyzamchi</span>
        </div>
        <a
          href="/chat.html"
          className="rounded-full border border-white/15 bg-white/5 px-5 py-2 text-sm font-medium text-white/80 backdrop-blur-md transition-colors hover:bg-white/10 hover:text-white"
        >
          Войти
        </a>
      </header>

      {/* Hero */}
      <main className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pb-24 pt-12 text-center sm:pt-20">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-medium text-white/70 backdrop-blur-md"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.6)]" />
          AI-powered LegalTech ecosystem · Кыргызская Республика
        </motion.div>

        <TextReveal
          text="Miyzamchi. Искусственный интеллект для законодательства Кыргызской Республики"
          className="max-w-4xl justify-center bg-gradient-to-b from-white to-white/60 bg-clip-text text-center text-4xl font-bold leading-tight tracking-tight text-transparent sm:text-5xl md:text-6xl"
          delay={0.15}
        />

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.9 }}
          className="mx-auto mt-7 max-w-2xl text-base leading-relaxed text-white/60 sm:text-lg"
        >
          An AI-powered LegalTech ecosystem and intelligent assistant for the legislation of the
          Kyrgyz Republic. Анализ документов, поиск противоречий с НПА и профессиональный редактор —
          в одном месте.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 1.1 }}
          className="mt-10"
        >
          <ShimmerButton as="a" href="/chat.html">
            Открыть ИИ-ассистента
            <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">→</span>
          </ShimmerButton>
        </motion.div>

        {/* Bento Grid фич */}
        <section className="mt-28 w-full">
          <motion.h2
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="mb-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl"
          >
            Единая экосистема
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="mx-auto mb-12 max-w-xl text-sm text-white/50"
          >
            Три инструмента, которые закрывают весь цикл работы юриста.
          </motion.p>
          <BentoGrid />
        </section>
      </main>

      <footer className="border-t border-white/5 py-8 text-center text-xs text-white/40">
        © {new Date().getFullYear()} Miyzamchi · Юридический ИИ-ассистент Кыргызской Республики
      </footer>
    </AuroraBackground>
  );
}

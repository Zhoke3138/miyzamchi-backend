import React from 'react';
import { motion } from 'framer-motion';
import { AuroraBackground } from './AuroraBackground';
import { TextReveal } from './TextReveal';
import { ShimmerButton } from './ShimmerButton';
import { BentoGrid } from './BentoGrid';
import { cn } from '../../lib/utils';
import { LANGS, t as i18nT, getAppLang, setAppLang, subscribeLang } from '../../translations.js';

// Общий i18n-store (KY/RU/EN) — тот же, что у чата и воркспейса: выбранный язык
// сохраняется в localStorage['app_language'] и переживает переход на /chat.html.
const useLang = () => {
  const lang = React.useSyncExternalStore(subscribeLang, getAppLang);
  return { lang, tr: (k) => i18nT(k, lang), setLang: setAppLang };
};

function LangSwitch({ lang, setLang }) {
  return (
    <div
      role="group"
      aria-label="Тил / Язык / Language"
      className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 p-1 backdrop-blur-md"
    >
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={cn(
            'rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors',
            lang === l ? 'bg-white text-black shadow' : 'text-white/55 hover:text-white'
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export default function Landing() {
  const { lang, tr, setLang } = useLang();
  return (
    <AuroraBackground>
      {/* Навбар */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-6">
        <div className="flex items-center gap-3">
          <img
            src="/logo/Logo_transparent.png?v=2"
            alt="Miyzamchi"
            className="h-10 w-10 drop-shadow-[0_0_12px_rgba(92,102,222,0.6)]"
          />
          <span className="text-xl font-bold tracking-tight">Miyzamchi</span>
        </div>
        <div className="flex items-center gap-3">
          <LangSwitch lang={lang} setLang={setLang} />
          <a
            href="/chat.html"
            className="hidden rounded-full border border-white/15 bg-white/5 px-5 py-2 text-sm font-semibold text-white/80 backdrop-blur-md transition-colors hover:bg-white/10 hover:text-white sm:inline-block"
          >
            {tr('lp_signin')}
          </a>
        </div>
      </header>

      {/* Hero */}
      <main className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pb-24 pt-10 text-center sm:pt-16">
        {/* Крупный логотип */}
        <motion.img
          src="/logo/Logo_transparent.png?v=2"
          alt="Miyzamchi"
          initial={{ opacity: 0, scale: 0.7, y: -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.21, 0.47, 0.32, 0.98] }}
          className="mb-6 h-24 w-24 drop-shadow-[0_0_28px_rgba(92,102,222,0.65)] sm:h-28 sm:w-28"
        />

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-semibold text-white/75 backdrop-blur-md sm:text-sm"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.6)]" />
          {tr('lp_badge')}
        </motion.div>

        <TextReveal
          key={lang}
          text={tr('lp_title')}
          className="max-w-5xl justify-center bg-gradient-to-b from-white via-white to-white/55 bg-clip-text text-center text-5xl font-extrabold leading-[1.05] tracking-tight text-transparent drop-shadow-[0_2px_30px_rgba(92,102,222,0.25)] sm:text-6xl md:text-7xl"
          delay={0.1}
        />

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.85 }}
          className="mx-auto mt-8 max-w-2xl text-lg font-medium leading-relaxed text-white/70 sm:text-xl"
        >
          {tr('lp_subtitle')}
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 1.05 }}
          className="mt-10"
        >
          <ShimmerButton as="a" href="/chat.html" className="px-9 py-4 text-lg font-bold">
            {tr('lp_cta')}
            <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">
              →
            </span>
          </ShimmerButton>
        </motion.div>

        {/* Bento Grid фич */}
        <section className="mt-28 w-full">
          <motion.h2
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="mb-3 text-3xl font-extrabold tracking-tight text-white sm:text-4xl"
          >
            {tr('lp_section_title')}
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="mx-auto mb-12 max-w-xl text-base font-medium text-white/55"
          >
            {tr('lp_section_subtitle')}
          </motion.p>
          <BentoGrid tr={tr} />
        </section>
      </main>

      <footer className="border-t border-white/5 py-8 text-center text-xs text-white/45">
        © {new Date().getFullYear()} Miyzamchi · {tr('lp_footer')}
      </footer>
    </AuroraBackground>
  );
}

import React from 'react';
import { motion } from 'framer-motion';
import { AuroraBackground } from './AuroraBackground';
import { TextReveal } from './TextReveal';
import { BentoGrid } from './BentoGrid';
import { cn } from '../../lib/utils';
import { LANGS, t as i18nT, getAppLang, setAppLang, subscribeLang } from '../../translations.js';
import { createClient } from '@supabase/supabase-js';

const _SUPA_URL = import.meta.env.VITE_SUPABASE_URL || '';
const _SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const _supabase = (_SUPA_URL && _SUPA_KEY) ? createClient(_SUPA_URL, _SUPA_KEY) : null;

const signInWithGoogle = () => {
  if (!_supabase) { window.location.href = '/workspace.html'; return; }
  _supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + '/workspace.html' }
  });
};

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
          <button
            type="button"
            onClick={signInWithGoogle}
            className="hidden rounded-full border border-white/15 bg-white/5 px-5 py-2 text-sm font-semibold text-white/80 backdrop-blur-md transition-colors hover:bg-white/10 hover:text-white sm:inline-block"
          >
            {tr('lp_signin')}
          </button>
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
          className="mb-4 inline-flex items-center gap-2.5 rounded-full border border-white/20 bg-white/10 px-6 py-2 text-base font-extrabold text-white/95 backdrop-blur-md sm:text-lg shadow-[0_0_15px_rgba(255,255,255,0.1)]"
        >
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_3px_rgba(52,211,153,0.8)]" />
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
          className="mx-auto mt-4 max-w-2xl text-lg font-medium leading-relaxed text-white/70 sm:text-xl"
        >
          {tr('lp_subtitle')}
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 1.05 }}
          className="mt-10"
        >
          <button
            type="button"
            onClick={signInWithGoogle}
            style={{
              display:'inline-flex',alignItems:'center',gap:12,
              padding:'14px 36px',borderRadius:12,
              background:'#fff',color:'#333',border:'none',
              fontSize:17,fontWeight:600,cursor:'pointer',
              boxShadow:'0 4px 24px rgba(0,0,0,0.35)',
              transition:'transform 0.15s, box-shadow 0.15s'
            }}
            onMouseEnter={e=>{e.currentTarget.style.transform='scale(1.03)';e.currentTarget.style.boxShadow='0 8px 32px rgba(0,0,0,0.45)'}}
            onMouseLeave={e=>{e.currentTarget.style.transform='scale(1)';e.currentTarget.style.boxShadow='0 4px 24px rgba(0,0,0,0.35)'}}
          >
            <svg width="22" height="22" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Войти через Google
          </button>
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

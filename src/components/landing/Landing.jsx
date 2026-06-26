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

const useLang = () => {
  const lang = React.useSyncExternalStore(subscribeLang, getAppLang);
  return { lang, tr: (k) => i18nT(k, lang), setLang: setAppLang };
};

// Иконка солнца
const SunIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="4"/>
    <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
    <line x1="4.22" y1="4.22" x2="7.05" y2="7.05"/><line x1="16.95" y1="16.95" x2="19.78" y2="19.78"/>
    <line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
    <line x1="4.22" y1="19.78" x2="7.05" y2="16.95"/><line x1="16.95" y1="7.05" x2="19.78" y2="4.22"/>
  </svg>
);

// Иконка луны
const MoonIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>
);

function LangSwitch({ lang, setLang, dark }) {
  return (
    <div
      role="group"
      aria-label="Тил / Язык / Language"
      className={cn(
        'inline-flex items-center gap-1 rounded-full border p-1 backdrop-blur-md',
        dark ? 'border-white/15 bg-white/5' : 'border-black/10 bg-black/5'
      )}
    >
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={cn(
            'rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors',
            dark
              ? lang === l ? 'bg-white text-black shadow' : 'text-white/55 hover:text-white'
              : lang === l ? 'bg-gray-900 text-white shadow' : 'text-gray-500 hover:text-gray-900'
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
  const [dark, setDark] = React.useState(() => localStorage.getItem('myz-dk') !== '0');

  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    localStorage.setItem('myz-dk', next ? '1' : '0');
  };

  const d = dark;

  return (
    <AuroraBackground dark={d}>
      {/* Навбар */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-6">
        <div className="flex items-center gap-3">
          <img
            src="/logo/Logo_transparent.png?v=2"
            alt="Miyzamchi"
            className="h-10 w-10"
            style={{ filter: d ? 'drop-shadow(0 0 12px rgba(92,102,222,0.6))' : 'drop-shadow(0 0 8px rgba(92,102,222,0.3))' }}
          />
          <span className={cn('text-xl font-bold tracking-tight', d ? 'text-white' : 'text-gray-900')}>
            Miyzamchi
          </span>
        </div>
        <div className="flex items-center gap-3">
          <LangSwitch lang={lang} setLang={setLang} dark={d} />

          {/* Кнопка темы */}
          <button
            type="button"
            onClick={toggleDark}
            title={d ? 'Светлая тема' : 'Тёмная тема'}
            className={cn(
              'inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors',
              d
                ? 'border-white/15 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white'
                : 'border-black/10 bg-black/5 text-gray-500 hover:bg-black/10 hover:text-gray-900'
            )}
          >
            {d ? <SunIcon /> : <MoonIcon />}
          </button>

          {/* Войти */}
          <button
            type="button"
            onClick={signInWithGoogle}
            className={cn(
              'hidden rounded-full border px-5 py-2 text-sm font-semibold backdrop-blur-md transition-colors sm:inline-block',
              d
                ? 'border-white/15 bg-white/5 text-white/80 hover:bg-white/10 hover:text-white'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100 hover:text-gray-900'
            )}
          >
            {tr('lp_signin')}
          </button>
        </div>
      </header>

      {/* Hero */}
      <main className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pb-24 pt-10 text-center sm:pt-16">
        {/* Логотип */}
        <motion.img
          src="/logo/Logo_transparent.png?v=2"
          alt="Miyzamchi"
          initial={{ opacity: 0, scale: 0.7, y: -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.21, 0.47, 0.32, 0.98] }}
          className="mb-6 h-24 w-24 sm:h-28 sm:w-28"
          style={{ filter: d ? 'drop-shadow(0 0 28px rgba(92,102,222,0.65))' : 'drop-shadow(0 0 16px rgba(92,102,222,0.3))' }}
        />

        {/* Бейдж */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className={cn(
            'mb-4 inline-flex items-center gap-2.5 rounded-full border px-6 py-2 text-base font-extrabold backdrop-blur-md sm:text-lg',
            d
              ? 'border-white/20 bg-white/10 text-white/95 shadow-[0_0_15px_rgba(255,255,255,0.1)]'
              : 'border-gray-200 bg-white/80 text-gray-800 shadow-sm'
          )}
        >
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_3px_rgba(52,211,153,0.8)]" />
          {tr('lp_badge')}
        </motion.div>

        {/* Заголовок */}
        <TextReveal
          key={lang + String(d)}
          text={tr('lp_title')}
          className={cn(
            'max-w-5xl justify-center bg-clip-text text-center text-5xl font-extrabold leading-[1.05] tracking-tight text-transparent sm:text-6xl md:text-7xl',
            d
              ? 'bg-gradient-to-b from-white via-white to-white/55 drop-shadow-[0_2px_30px_rgba(92,102,222,0.25)]'
              : 'bg-gradient-to-b from-gray-900 via-gray-800 to-gray-600'
          )}
          delay={0.1}
        />

        {/* Подзаголовок */}
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.85 }}
          className={cn(
            'mx-auto mt-4 max-w-2xl text-lg font-medium leading-relaxed sm:text-xl',
            d ? 'text-white/70' : 'text-gray-600'
          )}
        >
          {tr('lp_subtitle')}
        </motion.p>

        {/* Google кнопка */}
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
              background:'#fff',color:'#333',border: d ? 'none' : '1px solid #e5e7eb',
              fontSize:17,fontWeight:600,cursor:'pointer',
              boxShadow: d ? '0 4px 24px rgba(0,0,0,0.35)' : '0 2px 12px rgba(0,0,0,0.10)',
              transition:'transform 0.15s, box-shadow 0.15s'
            }}
            onMouseEnter={e=>{e.currentTarget.style.transform='scale(1.03)';}}
            onMouseLeave={e=>{e.currentTarget.style.transform='scale(1)';}}
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

        {/* Bento */}
        <section className="mt-28 w-full">
          <motion.h2
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className={cn('mb-3 text-3xl font-extrabold tracking-tight sm:text-4xl', d ? 'text-white' : 'text-gray-900')}
          >
            {tr('lp_section_title')}
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className={cn('mx-auto mb-12 max-w-xl text-base font-medium', d ? 'text-white/55' : 'text-gray-500')}
          >
            {tr('lp_section_subtitle')}
          </motion.p>
          <BentoGrid tr={tr} dark={d} />
        </section>
      </main>

      <footer className={cn('border-t py-8 text-center text-xs', d ? 'border-white/5 text-white/45' : 'border-gray-200 text-gray-400')}>
        © {new Date().getFullYear()} Miyzamchi · {tr('lp_footer')}
      </footer>
    </AuroraBackground>
  );
}

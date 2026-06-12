import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../lib/utils';

// Стеклянная карточка (glassmorphism) с мягким свечением и подъёмом при ховере.
function BentoCard({ item, index, className }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6, delay: index * 0.1, ease: [0.21, 0.47, 0.32, 0.98] }}
      className={cn(
        'group relative flex flex-col justify-between overflow-hidden rounded-3xl p-7',
        'border border-white/10 bg-white/[0.04] backdrop-blur-xl',
        'shadow-[0_8px_40px_-12px_rgba(0,0,0,0.6)] transition-all duration-300',
        'hover:-translate-y-1 hover:border-white/20 hover:bg-white/[0.07]',
        className
      )}
    >
      {/* Радиальный блик, следящий за акцентом карточки */}
      <div
        className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full opacity-40 blur-3xl transition-opacity duration-500 group-hover:opacity-70"
        style={{ background: item.glow }}
      />
      <div className="relative z-10">
        <div
          className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-2xl text-2xl"
          style={{ background: item.glow, boxShadow: `0 8px 24px -6px ${item.shadow}` }}
        >
          {item.icon}
        </div>
        <h3 className="mb-2 text-xl font-semibold tracking-tight text-white">{item.title}</h3>
        <p className="text-sm leading-relaxed text-white/60">{item.desc}</p>
      </div>
      <span className="relative z-10 mt-6 inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-white/40">
        {item.tag}
      </span>
    </motion.div>
  );
}

// Названия и теги — продуктовые/технические, остаются на английском во всех
// языках. Переводятся описания (descKey берётся из общего словаря).
const FEATURES = [
  {
    title: 'Smart Legal Workspace',
    descKey: 'lp_card1_desc',
    tag: 'SuperDoc Editor',
    icon: '📝',
    glow: 'radial-gradient(circle, rgba(92,102,222,0.55), transparent 70%)',
    shadow: 'rgba(92,102,222,0.6)'
  },
  {
    title: 'AI Law Navigator',
    descKey: 'lp_card2_desc',
    tag: 'Multi-agent RAG',
    icon: '⚖️',
    glow: 'radial-gradient(circle, rgba(139,92,246,0.55), transparent 70%)',
    shadow: 'rgba(139,92,246,0.6)'
  },
  {
    title: 'WhatsApp Billing CRM',
    descKey: 'lp_card3_desc',
    tag: 'CRM & Automation',
    icon: '💬',
    glow: 'radial-gradient(circle, rgba(46,204,113,0.5), transparent 70%)',
    shadow: 'rgba(46,204,113,0.55)'
  }
];

export function BentoGrid({ tr }) {
  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
      {/* Первая карточка крупнее на десктопе для «бенто»-ритма */}
      {FEATURES.map((item, i) => (
        <BentoCard
          key={item.title}
          item={{ ...item, desc: tr(item.descKey) }}
          index={i}
          className={i === 0 ? 'md:col-span-2 lg:col-span-1' : ''}
        />
      ))}
    </div>
  );
}

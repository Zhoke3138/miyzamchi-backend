import React from 'react';
import { cn } from '../../lib/utils';

// Тёмный фон с плавно движущимся северным сиянием (Aurora) + spotlight.
// Чистый CSS/GPU (transform-анимации в landing.css) — без тяжёлого JS.
export function AuroraBackground({ children, className }) {
  return (
    <div className={cn('relative min-h-screen w-full overflow-hidden bg-[#05060a] text-white', className)}>
      {/* Базовый радиальный spotlight сверху */}
      <div
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          background:
            'radial-gradient(60% 50% at 50% 0%, rgba(92,102,222,0.18) 0%, rgba(5,6,10,0) 70%)'
        }}
      />
      {/* Aurora blobs */}
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden blur-3xl">
        <div
          className="aurora-blob absolute -top-1/4 left-1/4 h-[42rem] w-[42rem] rounded-full opacity-50"
          style={{ background: 'conic-gradient(from 120deg, #5c66de, #8b5cf6, #3366ff, #5c66de)' }}
        />
        <div
          className="aurora-blob aurora-blob-2 absolute top-1/3 -right-1/4 h-[38rem] w-[38rem] rounded-full opacity-40"
          style={{ background: 'conic-gradient(from 300deg, #2ecc71, #3366ff, #8b5cf6, #2ecc71)' }}
        />
      </div>
      {/* Тонкая сетка-grid для «технологичности» */}
      <div
        className="pointer-events-none absolute inset-0 z-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #ffffff 1px, transparent 1px), linear-gradient(to bottom, #ffffff 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(70% 60% at 50% 30%, #000 40%, transparent 100%)'
        }}
      />
      {/* Виньетка снизу для читаемости */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-1/2"
        style={{ background: 'linear-gradient(to top, #05060a 5%, rgba(5,6,10,0) 100%)' }}
      />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

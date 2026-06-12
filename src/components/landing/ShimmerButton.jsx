import React from 'react';
import { cn } from '../../lib/utils';

// Shimmer Button (Magic UI): переливающаяся кнопка-портал.
// Блик-полоса бежит по поверхности (.shimmer-streak из landing.css).
export function ShimmerButton({ children, className, as = 'button', ...props }) {
  const Comp = as;
  return (
    <Comp
      className={cn(
        'group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-full',
        'border border-white/15 bg-white/10 px-8 py-4 text-base font-semibold text-white',
        'shadow-[0_8px_40px_-8px_rgba(92,102,222,0.6)] backdrop-blur-md',
        'transition-all duration-300 hover:scale-[1.03] hover:border-white/30 hover:bg-white/15',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70',
        className
      )}
      {...props}
    >
      {/* Переливающаяся полоса */}
      <span className="pointer-events-none absolute inset-0 -z-0 overflow-hidden rounded-full">
        <span className="shimmer-streak absolute inset-y-0 -left-1/2 w-1/2 skew-x-[-20deg] bg-gradient-to-r from-transparent via-white/40 to-transparent" />
      </span>
      {/* Градиентная подсветка по краю */}
      <span
        className="pointer-events-none absolute inset-0 -z-10 rounded-full opacity-70 blur-md transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: 'linear-gradient(90deg, rgba(92,102,222,0.5), rgba(139,92,246,0.5))' }}
      />
      <span className="relative z-10 flex items-center gap-2">{children}</span>
    </Comp>
  );
}

import React from 'react';
import { cn } from '../../lib/utils';

export function AuroraBackground({ children, className, dark = true }) {
  return (
    <div className={cn(
      'relative min-h-screen w-full overflow-hidden transition-colors duration-300',
      dark ? 'bg-[#05060a] text-white' : 'bg-[#f4f6ff] text-gray-900',
      className
    )}>
      {/* Spotlight */}
      <div className="pointer-events-none absolute inset-0 z-0" style={{
        background: dark
          ? 'radial-gradient(60% 50% at 50% 0%, rgba(92,102,222,0.18) 0%, rgba(5,6,10,0) 70%)'
          : 'radial-gradient(60% 50% at 50% 0%, rgba(92,102,222,0.10) 0%, rgba(244,246,255,0) 70%)'
      }}/>
      {/* Aurora blobs */}
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden blur-3xl">
        <div
          className="aurora-blob absolute -top-1/4 left-1/4 h-[42rem] w-[42rem] rounded-full"
          style={{
            opacity: dark ? 0.5 : 0.1,
            background: 'conic-gradient(from 120deg, #5c66de, #8b5cf6, #3366ff, #5c66de)'
          }}
        />
        <div
          className="aurora-blob aurora-blob-2 absolute top-1/3 -right-1/4 h-[38rem] w-[38rem] rounded-full"
          style={{
            opacity: dark ? 0.4 : 0.08,
            background: 'conic-gradient(from 300deg, #2ecc71, #3366ff, #8b5cf6, #2ecc71)'
          }}
        />
      </div>
      {/* Grid */}
      <div
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          opacity: dark ? 0.07 : 0.03,
          backgroundImage:
            'linear-gradient(to right, #000 1px, transparent 1px), linear-gradient(to bottom, #000 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(70% 60% at 50% 30%, #000 40%, transparent 100%)'
        }}
      />
      {/* Vignette */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-1/2"
        style={{
          background: dark
            ? 'linear-gradient(to top, #05060a 5%, rgba(5,6,10,0) 100%)'
            : 'linear-gradient(to top, #f4f6ff 5%, rgba(244,246,255,0) 100%)'
        }}
      />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

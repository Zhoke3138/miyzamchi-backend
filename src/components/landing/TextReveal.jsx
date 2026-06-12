import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../lib/utils';

// Эффект Text Reveal: слова заголовка плавно «всплывают» по очереди (stagger).
export function TextReveal({ text, className, delay = 0 }) {
  const words = String(text).split(' ');
  const container = {
    hidden: {},
    visible: { transition: { staggerChildren: 0.08, delayChildren: delay } }
  };
  const word = {
    hidden: { opacity: 0, y: 24, filter: 'blur(8px)' },
    visible: {
      opacity: 1,
      y: 0,
      filter: 'blur(0px)',
      transition: { duration: 0.6, ease: [0.21, 0.47, 0.32, 0.98] }
    }
  };
  return (
    <motion.h1
      className={cn('flex flex-wrap', className)}
      variants={container}
      initial="hidden"
      animate="visible"
      aria-label={text}
    >
      {words.map((w, i) => (
        <motion.span key={i} variants={word} className="mr-[0.25em] inline-block">
          {w}
        </motion.span>
      ))}
    </motion.h1>
  );
}

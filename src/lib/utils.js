import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Стандартный Aceternity/shadcn-хелпер: мерджит Tailwind-классы без конфликтов.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

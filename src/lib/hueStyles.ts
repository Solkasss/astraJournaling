import type { StarHue } from './journalTypes';

export const hueChip: Record<StarHue, string> = {
  lavender: 'border-star-lavender/25 bg-star-lavender/10 text-star-lavender',
  gold: 'border-star-gold/25 bg-star-gold/10 text-star-gold',
  cyan: 'border-star-cyan/25 bg-star-cyan/10 text-star-cyan',
};

export const hueDot: Record<StarHue, string> = {
  lavender: 'bg-star-lavender shadow-glow-lavender',
  gold: 'bg-star-gold shadow-glow-gold',
  cyan: 'bg-star-cyan shadow-glow-cyan',
};

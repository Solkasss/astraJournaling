/** Read a CSS custom property from :root (for canvas rendering). */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

/** Build an hsl() color from an HSL triplet token value. */
export function hsla(triplet: string, alpha: number): string {
  return `hsl(${triplet} / ${Math.max(0, Math.min(1, alpha))})`;
}

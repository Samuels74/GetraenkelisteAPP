/** App logo: a beer mug on the brand color (same artwork as the PWA icons). */
export function AppLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden focusable="false">
      <rect width="64" height="64" rx="16" fill="#c2410c" />
      <path d="M44 27h3.5a5.5 5.5 0 0 1 5.5 5.5v6a5.5 5.5 0 0 1-5.5 5.5H44" fill="none" stroke="#fff" strokeWidth="4.5" />
      <path d="M15 24h29v24a5 5 0 0 1-5 5H20a5 5 0 0 1-5-5z" fill="#fff" />
      <rect x="19.5" y="29" width="20" height="19.5" rx="2.5" fill="#f59e0b" />
      <circle cx="19.5" cy="21.5" r="6" fill="#fff" />
      <circle cx="29.5" cy="18" r="7.5" fill="#fff" />
      <circle cx="39.5" cy="21.5" r="6" fill="#fff" />
      <rect x="15" y="20" width="29" height="6" fill="#fff" />
    </svg>
  );
}

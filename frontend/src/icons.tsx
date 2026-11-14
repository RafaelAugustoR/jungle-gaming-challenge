// One authored icon set: 24px grid, 1.75 stroke, square caps to match the ticket's straight rules.
import type { JSX } from 'preact';

const paths = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  strike: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  ticket: 'M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4zM14 6v12',
  ledger: 'M5 4h14v16H5zM9 8h6M9 12h6M9 16h3',
  stop: 'M7 7h10v10H7z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  alert: 'M12 8v5M12 16.5v.5M3 20h18L12 4z',
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 18,
  ...rest
}: { name: IconName; size?: number } & JSX.SVGAttributes<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="square"
      stroke-linejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function Mark() {
  // Lastro's mark: a ticket stub with its perforation, drawn as plain geometry.
  return (
    <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true" focusable="false">
      <path d="M3 6h22v5.5a2.5 2.5 0 0 0 0 5V22H3z" fill="var(--ticket)" />
      <path d="M17 7.5v13" stroke="var(--rail)" stroke-width="1.75" stroke-dasharray="2 2" />
      <path d="M7 11h6M7 14h6M7 17h4" stroke="var(--rail)" stroke-width="1.75" />
    </svg>
  );
}

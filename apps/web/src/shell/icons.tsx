import { ReactElement } from 'react';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 } as const;

export const SunIcon = (): ReactElement => (
  <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 18 18" {...stroke}>
    <circle cx="9" cy="9" r="3.4" />
    <path d="M9 1v2.2M9 14.8V17M1 9h2.2M14.8 9H17M3.4 3.4l1.6 1.6M13 13l1.6 1.6M14.6 3.4L13 5M5 13l-1.6 1.6" />
  </svg>
);

export const RoofIcon = (): ReactElement => (
  <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 18 18" {...stroke}>
    <path d="M1.6 7.4L9 2l7.4 5.4M3.6 8.8v6.6h10.8V8.8M7 15.4v-3.4h4v3.4" />
  </svg>
);

export const TrendIcon = (): ReactElement => (
  <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 18 18" {...stroke}>
    <path d="M2 15.2h14M4 15.2V9M8 15.2V4.6M12 15.2v-4M16 15.2V6.6" />
  </svg>
);

export const HealthIcon = (): ReactElement => (
  <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 18 18" {...stroke}>
    <path d="M9 1.8l6.6 3v4.4c0 3.4-2.7 6-6.6 7-3.9-1-6.6-3.6-6.6-7V4.8z" />
    <path d="M9 6.4v3.2M9 12h.01" />
  </svg>
);

export const CarIcon = (): ReactElement => (
  <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 18 18" {...stroke}>
    <path d="M2.4 10.2l1.2-4a1.6 1.6 0 011.5-1.1h7.8a1.6 1.6 0 011.5 1.1l1.2 4M2.4 10.2h13.2v3.6a.8.8 0 01-.8.8h-1.2a.8.8 0 01-.8-.8v-.8H5.2v.8a.8.8 0 01-.8.8H3.2a.8.8 0 01-.8-.8z" />
    <path d="M4.8 12.2h.01M13.2 12.2h.01" />
  </svg>
);

export const PlugIcon = (): ReactElement => (
  <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 18 18" {...stroke}>
    <path d="M6 2v4M12 2v4M4.5 6h9v3.5a4.5 4.5 0 01-9 0zM9 14v3" />
  </svg>
);

export const BatteryIcon = (): ReactElement => (
  <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 18 18" {...stroke}>
    <rect x="2" y="5" width="12" height="8" rx="1.5" />
    <path d="M15.5 7.5v3" />
    <path d="M5 9h4" />
  </svg>
);

export const SystemIcon = (): ReactElement => (
  <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 18 18" {...stroke}>
    <rect x="2.5" y="2.5" width="5" height="5" rx="1.2" />
    <rect x="10.5" y="2.5" width="5" height="5" rx="1.2" />
    <rect x="2.5" y="10.5" width="5" height="5" rx="1.2" />
    <rect x="10.5" y="10.5" width="5" height="5" rx="1.2" />
  </svg>
);

export const SavingsIcon = (): ReactElement => (
  <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 18 18" {...stroke}>
    <circle cx="9" cy="9" r="7" />
    <path d="M11 6.2c-.5-.7-1.3-1-2-1-1.1 0-2 .6-2 1.6 0 2.2 4 1 4 3.2 0 1-.9 1.7-2 1.7-.8 0-1.6-.4-2-1.1M9 4.2v1M9 12.8v1" />
  </svg>
);

export const GearIcon = (): ReactElement => (
  <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 18 18" {...stroke}>
    <circle cx="9" cy="9" r="2.6" />
    <path d="M9 1.4v2M9 14.6v2M1.4 9h2M14.6 9h2M3.6 3.6l1.4 1.4M13 13l1.4 1.4M14.4 3.6L13 5M5 13l-1.4 1.4" />
  </svg>
);

export const AlertTriangle = (): ReactElement => (
  <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7}>
    <path d="M10 2.4l7.4 14.2H2.6z" />
    <path d="M10 7.6v4M10 13.9h.01" />
  </svg>
);

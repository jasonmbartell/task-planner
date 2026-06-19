/**
 * Apple HIG — Light theme.
 *
 * Shipped as a built-in CSS snippet. Activating it adds (or toggles) a
 * snippet with id `theme-apple-hig-light` in the user's customCssConfig,
 * which `useCustomCss` injects as a <style> tag late in <head> so it
 * wins the cascade over Tailwind utilities. Class-based selectors are
 * used with `!important` to override the dark/brass defaults.
 */

const css = String.raw`
/* ===== Apple HIG — Light ===== */

/* Disable CRT scanline overlay used by the dark theme */
.scanlines::after { display: none !important; }

/* Body — system font stack, near-white canvas, primary label color */
:root { color-scheme: light; }
body {
  background: #ffffff !important;
  color: #1d1d1f !important;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", system-ui, sans-serif !important;
}
.font-mono,
.font-mono * {
  font-family: "SF Mono", ui-monospace, "JetBrains Mono", "IBM Plex Mono", Menlo, Consolas, monospace !important;
}

/* ===== Surfaces ===== */
.bg-surface-0       { background-color: #ffffff !important; }
.bg-surface-0\/80   { background-color: rgba(255,255,255,0.85) !important; }
.bg-surface-0\/90   { background-color: rgba(255,255,255,0.92) !important; }
.bg-surface-0\/95   { background-color: rgba(255,255,255,0.95) !important; }

.bg-surface-1       { background-color: #f5f5f7 !important; }
.bg-surface-1\/30   { background-color: rgba(245,245,247,0.55) !important; }
.bg-surface-1\/50   { background-color: rgba(245,245,247,0.70) !important; }
.bg-surface-1\/80   { background-color: rgba(245,245,247,0.85) !important;
                      backdrop-filter: saturate(180%) blur(12px) !important;
                      -webkit-backdrop-filter: saturate(180%) blur(12px) !important; }

.bg-surface-2       { background-color: #ffffff !important; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06); }
.bg-surface-2\/10   { background-color: rgba(245,245,247,0.40) !important; }
.bg-surface-2\/30   { background-color: rgba(245,245,247,0.60) !important; }
.bg-surface-2\/40   { background-color: rgba(245,245,247,0.70) !important; }
.bg-surface-2\/50   { background-color: rgba(245,245,247,0.80) !important; }

/* ===== Accent: amber → System Blue (#007AFF) ===== */
.bg-accent-amber       { background-color: #007AFF !important; color: #ffffff !important; }
.bg-accent-amber\/5    { background-color: rgba(0,122,255,0.05) !important; }
.bg-accent-amber\/10   { background-color: rgba(0,122,255,0.10) !important; }
.bg-accent-amber\/15   { background-color: rgba(0,122,255,0.12) !important; }
.bg-accent-amber\/20   { background-color: rgba(0,122,255,0.16) !important; }
.bg-accent-amber\/25   { background-color: rgba(0,122,255,0.20) !important; }
.bg-accent-amber\/30   { background-color: rgba(0,122,255,0.24) !important; }
.bg-accent-amber\/40   { background-color: rgba(0,122,255,0.34) !important; }
.bg-accent-amber\/60   { background-color: rgba(0,122,255,0.55) !important; }

.text-accent-amber       { color: #007AFF !important; }
.text-accent-amber\/25   { color: rgba(0,122,255,0.55) !important; }
.text-accent-amber\/30   { color: rgba(0,122,255,0.60) !important; }
.text-accent-amber\/40   { color: rgba(0,122,255,0.70) !important; }
.text-accent-amber\/50   { color: rgba(0,122,255,0.78) !important; }
.text-accent-amber\/60   { color: rgba(0,122,255,0.85) !important; }
.text-accent-amber\/70   { color: rgba(0,122,255,0.92) !important; }
.text-accent-amber\/80   { color: #007AFF !important; }

.border-accent-amber       { border-color: #007AFF !important; }
.border-accent-amber\/5    { border-color: rgba(60,60,67,0.10) !important; }
.border-accent-amber\/10   { border-color: rgba(60,60,67,0.12) !important; }
.border-accent-amber\/15   { border-color: rgba(60,60,67,0.14) !important; }
.border-accent-amber\/20   { border-color: rgba(0,122,255,0.25) !important; }
.border-accent-amber\/30   { border-color: rgba(0,122,255,0.40) !important; }
.border-accent-amber\/40   { border-color: rgba(0,122,255,0.55) !important; }
.border-accent-amber\/60   { border-color: rgba(0,122,255,0.70) !important; }

.hover\:bg-accent-amber:hover       { background-color: #006FE6 !important; color: #ffffff !important; }
.hover\:bg-accent-amber\/5:hover    { background-color: rgba(0,122,255,0.06) !important; }
.hover\:bg-accent-amber\/10:hover   { background-color: rgba(0,122,255,0.10) !important; }
.hover\:bg-accent-amber\/20:hover   { background-color: rgba(0,122,255,0.16) !important; }
.hover\:bg-accent-amber\/25:hover   { background-color: rgba(0,122,255,0.20) !important; }
.hover\:bg-accent-amber\/40:hover   { background-color: rgba(0,122,255,0.34) !important; }
.hover\:border-accent-amber:hover       { border-color: #007AFF !important; }
.hover\:border-accent-amber\/30:hover   { border-color: rgba(0,122,255,0.40) !important; }
.hover\:border-accent-amber\/40:hover   { border-color: rgba(0,122,255,0.55) !important; }
.hover\:text-accent-amber:hover     { color: #007AFF !important; }
.hover\:text-accent-amber\/60:hover { color: rgba(0,122,255,0.85) !important; }
.hover\:text-accent-amber\/70:hover { color: rgba(0,122,255,0.92) !important; }

/* ===== Accent: cream → label colors (primary / secondary / tertiary) ===== */
.text-accent-cream       { color: #1d1d1f !important; }
.text-accent-cream\/90   { color: #1d1d1f !important; }
.text-accent-cream\/80   { color: #1d1d1f !important; }
.text-accent-cream\/70   { color: #2d2d2f !important; }
.text-accent-cream\/60   { color: #4a4a4d !important; }
.text-accent-cream\/55   { color: #6e6e73 !important; }
.text-accent-cream\/50   { color: #6e6e73 !important; }
.text-accent-cream\/40   { color: #8e8e93 !important; }
.text-accent-cream\/30   { color: #a1a1a6 !important; }
.text-accent-cream\/25   { color: #b0b0b5 !important; }
.text-accent-cream\/20   { color: #c7c7cc !important; }

.bg-accent-cream\/10     { background-color: rgba(60,60,67,0.06) !important; }
.bg-accent-cream\/15     { background-color: rgba(60,60,67,0.09) !important; }
.bg-accent-cream\/30     { background-color: rgba(60,60,67,0.16) !important; }

.border-accent-cream\/5  { border-color: rgba(60,60,67,0.06) !important; }
.border-accent-cream\/10 { border-color: rgba(60,60,67,0.10) !important; }
.border-accent-cream\/15 { border-color: rgba(60,60,67,0.12) !important; }
.border-accent-cream\/20 { border-color: rgba(60,60,67,0.16) !important; }
.border-accent-cream\/30 { border-color: rgba(60,60,67,0.22) !important; }
.border-accent-cream\/40 { border-color: rgba(60,60,67,0.30) !important; }

.hover\:text-accent-cream:hover       { color: #1d1d1f !important; }
.hover\:text-accent-cream\/60:hover   { color: #4a4a4d !important; }
.hover\:text-accent-cream\/70:hover   { color: #2d2d2f !important; }
.hover\:text-accent-cream\/80:hover   { color: #1d1d1f !important; }
.hover\:border-accent-cream\/30:hover { border-color: rgba(60,60,67,0.22) !important; }
.hover\:border-accent-cream\/40:hover { border-color: rgba(60,60,67,0.30) !important; }

/* ===== Accent: green → System Green ===== */
.bg-accent-green        { background-color: #34C759 !important; color: #ffffff !important; }
.bg-accent-green\/5     { background-color: rgba(52,199,89,0.08) !important; }
.bg-accent-green\/10    { background-color: rgba(52,199,89,0.14) !important; }
.text-accent-green      { color: #248A3D !important; }
.border-accent-green\/30 { border-color: rgba(52,199,89,0.40) !important; }
.border-accent-green\/40 { border-color: rgba(52,199,89,0.55) !important; }
.hover\:bg-accent-green\/10:hover { background-color: rgba(52,199,89,0.14) !important; }

/* ===== Accent: red → System Red ===== */
.bg-accent-red        { background-color: #FF3B30 !important; color: #ffffff !important; }
.bg-accent-red\/5     { background-color: rgba(255,59,48,0.06) !important; }
.bg-accent-red\/10    { background-color: rgba(255,59,48,0.10) !important; }
.bg-accent-red\/20    { background-color: rgba(255,59,48,0.16) !important; }
.bg-accent-red\/80    { background-color: rgba(255,59,48,0.85) !important; color: #ffffff !important; }

.text-accent-red      { color: #D70015 !important; }
.text-accent-red\/70  { color: rgba(215,0,21,0.82) !important; }
.text-accent-red\/80  { color: rgba(215,0,21,0.92) !important; }
.text-accent-red\/90  { color: #D70015 !important; }

.border-accent-red       { border-color: #FF3B30 !important; }
.border-accent-red\/20   { border-color: rgba(255,59,48,0.28) !important; }
.border-accent-red\/30   { border-color: rgba(255,59,48,0.42) !important; }
.border-accent-red\/40   { border-color: rgba(255,59,48,0.55) !important; }
.border-accent-red\/60   { border-color: rgba(255,59,48,0.72) !important; }

.hover\:bg-accent-red\/10:hover    { background-color: rgba(255,59,48,0.10) !important; }
.hover\:border-accent-red\/60:hover { border-color: rgba(255,59,48,0.72) !important; }
.hover\:text-accent-red:hover      { color: #D70015 !important; }

/* ===== Accent: blue (sparingly used) ===== */
.bg-accent-blue       { background-color: #007AFF !important; color: #ffffff !important; }
.text-accent-blue     { color: #0040DD !important; }
.border-accent-blue\/40 { border-color: rgba(0,122,255,0.45) !important; }

/* ===== Accent: slate → System Gray ===== */
.bg-accent-slate      { background-color: #8E8E93 !important; color: #ffffff !important; }

/* ===== Inputs ===== */
input, textarea, select {
  caret-color: #007AFF;
}
input::placeholder, textarea::placeholder {
  color: #b0b0b5 !important;
}

/* Buttons inside the Apple HIG theme — soften the brutalist square corners
   used throughout the dark theme to match HIG's softer geometry. */
button { border-radius: 6px; }

/* Selection — System Blue at low alpha */
::selection { background: rgba(0,122,255,0.20); color: #1d1d1f; }

/* ===== Scrollbar — Apple thin overlay ===== */
::-webkit-scrollbar { width: 8px !important; height: 8px !important; }
::-webkit-scrollbar-track { background: transparent !important; }
::-webkit-scrollbar-thumb {
  background: rgba(60,60,67,0.20) !important;
  border-radius: 4px !important;
  border: 2px solid transparent !important;
  background-clip: padding-box !important;
}
::-webkit-scrollbar-thumb:hover { background: rgba(60,60,67,0.35) !important; background-clip: padding-box !important; }

/* Date picker indicator — undo the dark-theme invert filter */
input[type="date"]::-webkit-calendar-picker-indicator { filter: none !important; }
`;

export const appleHigLight = {
  id: 'theme-apple-hig-light',
  name: 'Apple HIG — Light',
  description: 'White canvas, system font, System Blue accents, no scanlines.',
  css,
};

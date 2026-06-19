export const PROJECT_COLORS = [
  '#c0392b', // mission red
  '#d4a843', // amber/gold
  '#33a85a', // console green
  '#3a7cc2', // nasa blue
  '#2a8a8a', // teal
  '#b85c38', // rust/copper
  '#7a8a3a', // olive
  '#6b7f99', // slate
  '#c87533', // copper
  '#8b5e3c', // burnt sienna
  '#2c5282', // navy
  '#a0522d', // saddle brown
];

export const getNextColor = (usedColors) => {
  const available = PROJECT_COLORS.filter((c) => !usedColors.includes(c));
  return available.length > 0 ? available[0] : PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)];
};

export const withAlpha = (hex, alpha) => {
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return `${hex}${a}`;
};

export const urgencyColor = (value) => {
  // 1 = most urgent (red), 10 = least urgent (green)
  const t = (value - 1) / 9;
  const r = Math.round(192 * (1 - t) + 51 * t);
  const g = Math.round(57 * (1 - t) + 168 * t);
  const b = Math.round(43 * (1 - t) + 90 * t);
  return `rgb(${r}, ${g}, ${b})`;
};

export const impactColor = (value) => {
  // 1 = highest impact (red), 5 = lowest impact (green)
  const t = (value - 1) / 4;
  const r = Math.round(192 * (1 - t) + 51 * t);
  const g = Math.round(57 * (1 - t) + 168 * t);
  const b = Math.round(43 * (1 - t) + 90 * t);
  return `rgb(${r}, ${g}, ${b})`;
};

export const difficultyColor = (value) => {
  // 1 = easiest (green), 5 = hardest (red)
  const t = (5 - value) / 4;
  const r = Math.round(192 * (1 - t) + 51 * t);
  const g = Math.round(57 * (1 - t) + 168 * t);
  const b = Math.round(43 * (1 - t) + 90 * t);
  return `rgb(${r}, ${g}, ${b})`;
};

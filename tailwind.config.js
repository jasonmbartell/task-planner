/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"IBM Plex Mono"', 'monospace'],
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
      },
      colors: {
        surface: {
          0: '#0b1220',
          1: '#101b2e',
          2: '#162440',
          3: '#1e2f4d',
          4: '#273a58',
        },
        accent: {
          amber: '#d4a843',
          gold: '#b89530',
          green: '#33a85a',
          red: '#c0392b',
          blue: '#3a7cc2',
          teal: '#2a8a8a',
          cream: '#d4c9a8',
          rust: '#b85c38',
          slate: '#6b7f99',
          olive: '#7a8a3a',
          navy: '#2c5282',
          copper: '#c87533',
        },
      },
      borderRadius: {
        none: '0',
        sm: '2px',
        DEFAULT: '3px',
        md: '4px',
        lg: '4px',
      },
    },
  },
  plugins: [],
}

import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Manrope', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
} as Omit<Config, 'content'>;

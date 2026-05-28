/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
    './lib/**/*.{js,ts,jsx,tsx}',
  ],
  // Vendor pill colors are constructed in /lib/vendors.ts and referenced via
  // string templates. The JIT scan can pick them up via the content paths
  // above, but we safelist them explicitly so renames/refactors don't break
  // pill colors silently. Keep in sync with VENDOR_COLORS.
  safelist: [
    'bg-slate-800', 'bg-sky-500', 'bg-teal-500',
    'bg-emerald-500', 'bg-violet-500', 'bg-amber-500',
    'bg-rose-600',
    'bg-gray-100', 'bg-gray-200',
    'text-white', 'text-gray-700', 'text-gray-900',
    'border', 'border-gray-300', 'border-gray-400',
  ],
  theme: {
    extend: {
      colors: {
        // ResiHome brand colors per brand guidelines
        brand: {
          DEFAULT: '#ff0060',   // Primary hot pink
          dark: '#cc004d',
          light: '#ff3380',
          deeper: '#990039',
        },
        accent: {
          DEFAULT: '#73e3df',   // Secondary teal
          dark: '#4ec5c0',
          light: '#a3eeeb',
        },
        ink: {
          DEFAULT: '#000000',
          soft: '#1a1a1a',
        },
      },
      fontFamily: {
        // Raleway for headers; Arial for body per brand guidelines
        heading: ['Raleway', 'Arial', 'sans-serif'],
        body: ['Arial', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

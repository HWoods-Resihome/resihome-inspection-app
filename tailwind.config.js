/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
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

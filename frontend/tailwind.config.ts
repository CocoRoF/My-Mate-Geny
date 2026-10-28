import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "#0f1115",
        panel: "#171a21",
        border: "#272b35",
        accent: "#6aa8ff",
      },
    },
  },
  plugins: [],
} satisfies Config;

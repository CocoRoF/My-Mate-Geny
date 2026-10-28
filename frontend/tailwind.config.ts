import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "#0a0c10",
        surface: "#0f1218",
        "surface-2": "#161a22",
        "surface-3": "#1c212c",
        border: "#232936",
        "border-strong": "#2f3647",
        content: "#e6e9f0",
        "content-dim": "#9aa3b4",
        "content-faint": "#5e6676",
        accent: "#6e8bff",
        "accent-hover": "#8098ff",
        "accent-soft": "#6e8bff22",
        cyan: "#22d3ee",
        violet: "#a78bfa",
        success: "#34d399",
        danger: "#f87171",
        warning: "#fbbf24",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        lg: "0.75rem",
        xl: "1rem",
        "2xl": "1.25rem",
      },
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,0.3), 0 8px 24px -12px rgba(0,0,0,0.5)",
        glow: "0 0 0 1px #6e8bff40, 0 8px 32px -8px #6e8bff40",
        float: "0 12px 40px -12px rgba(0,0,0,0.7)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "pulse-dot": {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.25s ease-out",
        "pulse-dot": "pulse-dot 1.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;

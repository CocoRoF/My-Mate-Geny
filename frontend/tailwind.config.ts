import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

/** a theme colour (src/index.css `--c-<name>: r g b`) that takes Tailwind's opacity modifiers (bg-accent/15) */
const token = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // the theme's tokens (src/index.css: dark and light values as CSS variables, src/lib/theme.ts picks one)
      colors: {
        bg: token("bg"),
        surface: token("surface"),
        "surface-2": token("surface-2"),
        "surface-3": token("surface-3"),
        border: token("border"),
        "border-strong": token("border-strong"),
        content: token("content"),
        "content-dim": token("content-dim"),
        "content-faint": token("content-faint"),
        accent: token("accent"),
        "accent-hover": token("accent-hover"),
        // the accent at the theme's soft strength (a further /N multiplies it)
        "accent-soft": "rgb(var(--c-accent) / calc(<alpha-value> * var(--accent-soft-a)))",
        link: token("link"),
        cyan: token("cyan"),
        violet: token("violet"),
        pink: token("pink"),
        success: token("success"),
        danger: token("danger"),
        warning: token("warning"),
        "file-blue": token("file-blue"),
        "file-orange": token("file-orange"),
        glass: token("glass"),
        "glass-deep": token("glass-deep"),
        "code-bg": token("code-bg"),
        // modal backdrops: black on dark, a softer ink on light (bg-scrim/50 → 50 % there, ~31 % here)
        scrim: "rgb(var(--c-scrim) / calc(<alpha-value> * var(--scrim-k)))",
      },
      fontFamily: {
        // Noto Sans KR: identical Korean rendering in browsers and the apps.
        sans: ["Inter", "Noto Sans KR", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        lg: "0.75rem",
        xl: "1rem",
        "2xl": "1.25rem",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        glow: "var(--shadow-glow)",
        float: "var(--shadow-float)",
        bubble: "var(--shadow-bubble)",
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
  plugins: [
    plugin(({ addVariant }) => {
      // `touch:` finger-sized targets on phones/tablets; `can-hover:` hover-only
      // affordances that touch screens must still show.
      addVariant("touch", "@media (hover: none) and (pointer: coarse)");
      addVariant("can-hover", "@media (hover: hover)");
    }),
  ],
} satisfies Config;

import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0b0d10",
          elevated: "#14181d",
          muted: "#1a1f26",
        },
        border: {
          DEFAULT: "#242a33",
          subtle: "#1a1f26",
        },
        fg: {
          DEFAULT: "#e6e9ef",
          muted: "#8a93a2",
          subtle: "#5a6270",
        },
        accent: {
          DEFAULT: "#4b8bff",
          hover: "#6aa0ff",
        },
        danger: "#ef4444",
        success: "#22c55e",
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;

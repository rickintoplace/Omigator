import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

// Omigator is a static app: NCBI, OpenRouter and Perplexity are called directly from the browser.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      // Two pages: the app and the privacy/imprint page.
      input: { main: "index.html", legal: "legal.html" },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});

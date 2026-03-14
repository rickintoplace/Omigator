import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import pkg from "./package.json";

const DEV_API_PORT = process.env.DEV_API_PORT || "8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  server: {
    port: 3000,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${DEV_API_PORT}`,
        changeOrigin: true
      },
      "/health": {
        target: `http://127.0.0.1:${DEV_API_PORT}`,
        changeOrigin: true
      }
    }
  }
});
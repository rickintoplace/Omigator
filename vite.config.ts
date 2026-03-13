import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const DEV_API_PORT = process.env.DEV_API_PORT || "8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
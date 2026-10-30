import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

/**
 * Serves the free-tier function (api/free.ts) in `npm run dev`, as Vercel does in production.
 * `.env` is read into this Node process only; nothing from it reaches the browser bundle.
 */
function freeTierDev(): Plugin {
  return {
    name: "omigator-free-tier-dev",
    apply: "serve",
    configureServer(server) {
      if (existsSync(".env")) process.loadEnvFile(".env");
      server.middlewares.use("/api/free", async (req: IncomingMessage & { originalUrl?: string }, res, next) => {
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
          headers.set("x-real-ip", req.socket.remoteAddress ?? "local");
          const request = new Request(`http://${req.headers.host}${req.originalUrl ?? req.url}`, {
            method: req.method,
            headers,
            body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
          });
          const mod = (await server.ssrLoadModule("/api/free.ts")) as { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };
          const response = await (req.method === "POST" ? mod.POST : mod.GET)(request);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

// The app is static: NCBI and OpenRouter are called directly from the browser. The one exception is
// the optional free tier (api/free.ts), which keeps its key on the server.
export default defineConfig({
  plugins: [react(), tailwindcss(), freeTierDev()],
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

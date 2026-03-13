import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, mode: "node-self-host" }));

app.get("/api/ncbi", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url || typeof url !== "string") return res.status(400).send("Missing ?url=");

    const allowed =
      url.startsWith("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/") ||
      url.startsWith("https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi");

    if (!allowed) return res.status(403).send("Blocked by proxy allowlist");

    const r = await fetch(url, {
      headers: { "User-Agent": "Omigator/1.0 (server proxy)", Accept: "*/*" }
    });

    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status);
    res.setHeader("content-type", r.headers.get("content-type") ?? "application/octet-stream");
    return res.send(buf);
  } catch (e: any) {
    console.error(e);
    return res.status(500).send(e?.message ?? "ncbi proxy error");
  }
});

app.post("/api/llm/chat", async (req, res) => {
  try {
    const provider = String(req.header("x-provider") ?? "").toLowerCase();
    const apiKey = String(req.header("x-api-key") ?? "");

    if (!apiKey) return res.status(400).send("Missing x-api-key");
    if (provider !== "saia" && provider !== "openrouter") {
      return res.status(400).send("Missing/invalid x-provider");
    }

    const url =
      provider === "saia"
        ? "https://chat-ai.academiccloud.de/v1/chat/completions"
        : "https://openrouter.ai/api/v1/chat/completions";

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(req.body ?? {})
    });

    const txt = await r.text();
    res.status(r.status);
    res.setHeader("content-type", r.headers.get("content-type") ?? "text/plain");
    return res.send(txt);
  } catch (e: any) {
    console.error(e);
    return res.status(500).send(e?.message ?? "llm proxy error");
  }
});

// Serve built frontend
const distDir = path.resolve(__dirname, "../dist");
app.use(express.static(distDir));
app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));

const port = process.env.PORT ? Number(process.env.PORT) : 8787;
app.listen(port, "0.0.0.0", () => console.log(`Omigator server listening on :${port}`));
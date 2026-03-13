import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, mode: "local-dev-express" }));

/**
 * Local implementation of Vercel: GET /api/ncbi?url=...
 */
app.get("/api/ncbi", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url || typeof url !== "string") {
      return res.status(400).send("Missing ?url=");
    }

    const allowed =
      url.startsWith("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/") ||
      url.startsWith("https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi");

    if (!allowed) return res.status(403).send("Blocked by proxy allowlist");

    const upstream = await fetch(url, {
      headers: {
        "User-Agent": "Omigator/1.0 (local dev proxy)",
        Accept: "*/*",
      },
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.setHeader(
      "content-type",
      upstream.headers.get("content-type") ?? "application/octet-stream"
    );
    return res.send(buf);
  } catch (e: any) {
    console.error(e);
    return res.status(500).send(e?.message ?? "ncbi proxy error");
  }
});

/**
 * Local implementation of Vercel: POST /api/llm/chat
 * Headers:
 *  - x-provider: saia|openrouter
 *  - x-api-key: user key
 */
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

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(req.body ?? {}),
    });

    const txt = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "text/plain");
    return res.send(txt);
  } catch (e: any) {
    console.error(e);
    return res.status(500).send(e?.message ?? "llm proxy error");
  }
});

const port = process.env.DEV_API_PORT ? Number(process.env.DEV_API_PORT) : 8787;
app.listen(port, "127.0.0.1", () => {
  console.log(`Local API (Express) listening on http://127.0.0.1:${port}`);
});
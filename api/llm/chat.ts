export const config = { runtime: "nodejs" };

type Provider = "saia" | "openrouter";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const provider = String(req.headers["x-provider"] ?? "").toLowerCase() as Provider;
    const apiKey = String(req.headers["x-api-key"] ?? "");

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
    res.send(txt);
  } catch (e: any) {
    console.error(e);
    res.status(500).send(e?.message ?? "llm proxy error");
  }
}
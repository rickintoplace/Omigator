export const config = { runtime: "nodejs" };

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  try {
    const url = req.query?.url;
    if (!url || typeof url !== "string") return res.status(400).send("Missing ?url=");

    const allowed =
      url.startsWith("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/") ||
      url.startsWith("https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi");
    if (!allowed) return res.status(403).send("Blocked by proxy allowlist");

    const upstream = await fetch(url, {
      headers: { "User-Agent": "Omigator/1.0 (vercel proxy)", Accept: "*/*" },
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/octet-stream");
    res.send(buf);
  } catch (e: any) {
    console.error(e);
    res.status(500).send(e?.message ?? "ncbi proxy error");
  }
}
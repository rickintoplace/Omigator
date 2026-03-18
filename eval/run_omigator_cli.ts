#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

type Provider = "saia" | "openrouter";

type Task = {
  name: string;
  query: string;
  maxResults: number;
  minDate?: string;
  maxDate?: string;

  organism?: string;
  assay?: string;
  minSamples?: number;

  llmPrompt: string;
  expectedTags: string;

  strategy: "saia_only" | "openrouter_only" | "saia_then_openrouter" | "openrouter_then_saia";
  saiaModels: string[];
  openRouterModels: string[];

  perModelTimeoutMs?: number;
  ncbiDelayMs?: number;

  concurrencyContext?: number;
  concurrencyLLM?: number;

  saiaMinIntervalMs?: number;
  openrouterMinIntervalMs?: number;
  rateLimitBackoffMs?: number;
};

type GeoResult = {
  gseId: string;
  title: string;
  summary: string;
  organism: string;
  assay: string;
  n_samples: number;
  pubDate: string;
  pmid?: string;
  paperAbstract?: string;
  overallDesign?: string;
  ftpLink?: string;

  llmScore?: number;
  llmDecision?: "include" | "exclude" | "unclear";
  llmReasoning?: string;
  llmTags?: string[];
  llmModelUsed?: string;
};

const API_BASE = process.env.OMIGATOR_API_BASE || "http://127.0.0.1:8787";
const SAIA_KEY = process.env.SAIA_API_KEY || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function usageAndExit(msg?: string): never {
  if (msg) console.error(msg);
  console.error(`
Usage:
  npx tsx eval/run_omigator_cli.ts --task eval/tasks/hypoxia.json --out eval/omigator_results.csv

Required env:
  - SAIA_API_KEY and/or OPENROUTER_API_KEY

Optional env:
  - OMIGATOR_API_BASE (default: http://127.0.0.1:8787)
`);
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const taskPath = get("--task");
  const outPath = get("--out");
  if (!taskPath || !outPath) usageAndExit("Missing --task or --out");
  return { taskPath, outPath };
}

function viaNcbiProxy(url: string) {
  return `${API_BASE}/api/ncbi?url=${encodeURIComponent(url)}`;
}

async function fetchText(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

async function fetchJson(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// ---------- async queue (producer/consumer) ----------
class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: ((v: T) => void)[] = [];
  private closed = false;

  push(item: T) {
    if (this.closed) throw new Error("Queue is closed");
    const r = this.resolvers.shift();
    if (r) r(item);
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    // unblock consumers with a sentinel via rejection-like behavior:
    // we resolve with undefined as sentinel using type cast
    while (this.resolvers.length) {
      const r = this.resolvers.shift()!;
      r(undefined as any);
    }
  }

  async pop(): Promise<T | null> {
    if (this.items.length) return this.items.shift()!;
    if (this.closed) return null;
    return new Promise<T>((resolve) => this.resolvers.push(resolve));
  }
}

// ---------- NCBI ----------
async function searchGeo(query: string, maxResults: number, minDate?: string, maxDate?: string): Promise<string[]> {
  let term = `${query} AND gse[entry type]`;
  if (minDate || maxDate) {
    const min = minDate ? minDate.replace(/-/g, "/") : "1000/01/01";
    const max = maxDate ? maxDate.replace(/-/g, "/") : "3000/01/01";
    term += ` AND ("${min}"[Publication Date] : "${max}"[Publication Date])`;
  }
  const encodedTerm = encodeURIComponent(term);
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gds&term=${encodedTerm}&retmode=json&retmax=${maxResults}`;
  const data = await fetchJson(viaNcbiProxy(url));
  return data.esearchresult?.idlist || [];
}

function xmlGetAll(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}
function xmlGetFirst(text: string, re: RegExp): string | undefined {
  const m = re.exec(text);
  return m ? m[1] : undefined;
}
function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchGeoSummaries(ids: string[], ncbiDelayMs: number): Promise<GeoResult[]> {
  if (ids.length === 0) return [];
  const results: GeoResult[] = [];
  const chunkSize = 50;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const url =
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi` +
      `?db=gds&id=${chunk.join(",")}&retmode=xml`;

    const xml = await fetchText(viaNcbiProxy(url));
    const docs = xmlGetAll(xml, /<DocSum>([\s\S]*?)<\/DocSum>/g);

    for (const doc of docs) {
      const uid = xmlGetFirst(doc, /<Id>(\d+)<\/Id>/);
      const getItem = (name: string) =>
        xmlGetFirst(doc, new RegExp(`<Item\\s+Name="${name}"[^>]*>([\\s\\S]*?)<\\/Item>`, "i"));

      const accession = decodeXml(getItem("Accession") ?? getItem("accession") ?? "");
      const title = decodeXml(getItem("title") ?? "No title");
      const summary = decodeXml(getItem("summary") ?? "No summary");
      const organism = decodeXml(getItem("taxon") ?? getItem("organism") ?? "Unknown");
      const assay = decodeXml(getItem("gdsType") ?? getItem("gdstype") ?? "Unknown");
      const nSamplesStr = getItem("n_samples") ?? getItem("N_Samples") ?? "0";
      const n_samples = parseInt(String(nSamplesStr).trim(), 10) || 0;
      const pubDate = decodeXml(getItem("PDAT") ?? getItem("pdat") ?? "Unknown");

      let pmid: string | undefined;
      const pubmed = getItem("PubMedIds") ?? getItem("pubmedids") ?? getItem("pubmedid");
      if (pubmed) {
        const m = String(pubmed).match(/\b\d+\b/);
        if (m) pmid = m[0];
      }

      results.push({
        gseId: accession || (uid ? `GSE${uid}` : "Unknown"),
        title,
        summary,
        organism,
        assay,
        n_samples,
        pubDate,
        pmid
      });
    }

    if (i + chunkSize < ids.length) await sleep(ncbiDelayMs);
  }

  return results;
}

async function fetchGeoDesignAndPrimaryPmid(gseId: string, retries: number) {
  const url = `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${gseId}&targ=self&form=text&view=quick`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const txt = await fetchText(viaNcbiProxy(url));

      const designMatches = txt.match(/!Series_overall_design = (.*)/g);
      const overallDesign = designMatches
        ? designMatches.map(m => m.replace("!Series_overall_design = ", "").trim()).join(" ")
        : "No overall design available.";

      const pmidMatch = txt.match(/!Series_pubmed_id = (\d+)/);
      const primaryPmid = pmidMatch ? pmidMatch[1] : undefined;

      return { overallDesign, primaryPmid };
    } catch {
      if (attempt < retries) await sleep(1000);
      else throw new Error(`Failed to fetch design for ${gseId}`);
    }
  }

  return { overallDesign: "Failed to fetch overall design.", primaryPmid: undefined as string | undefined };
}

async function fetchPubMedAbstract(pmid: string, retries: number) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const txt = await fetchText(viaNcbiProxy(url));
      const matches = txt.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g);
      return matches ? matches.map(m => m.replace(/<[^>]+>/g, "")).join(" ") : "No abstract available.";
    } catch {
      if (attempt < retries) await sleep(1000);
      else return "Failed to fetch abstract.";
    }
  }
  return "Failed to fetch abstract.";
}

// ---------- LLM ----------
type ThrottleState = { nextAllowedAt: number; chain: Promise<void> };
const throttleStates: Record<Provider, ThrottleState> = {
  saia: { nextAllowedAt: 0, chain: Promise.resolve() },
  openrouter: { nextAllowedAt: 0, chain: Promise.resolve() }
};

let SAIA_MIN_INTERVAL_MS = 3000;
let OPENROUTER_MIN_INTERVAL_MS = 800;
let BACKOFF_429_MS = 15000;

async function throttleLLM(provider: Provider) {
  const minInterval = provider === "saia" ? SAIA_MIN_INTERVAL_MS : OPENROUTER_MIN_INTERVAL_MS;
  const state = throttleStates[provider];

  state.chain = state.chain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, state.nextAllowedAt - now);
    if (wait > 0) await sleep(wait);
    state.nextAllowedAt = Date.now() + minInterval;
  });

  await state.chain;
}

function buildPrompt(dataset: GeoResult, userPrompt: string, expectedTags: string) {
  return `
You are an expert bioinformatician evaluating NCBI GEO datasets.

Dataset Metadata:
Title: ${dataset.title}
Summary: ${dataset.summary}
Overall Design: ${dataset.overallDesign || "Not available"}
Organism: ${dataset.organism}
Assay Type: ${dataset.assay}
Samples: ${dataset.n_samples}
Paper Abstract/Methods: ${dataset.paperAbstract || "Not available"}
FTP Link (Proxy for Filenames): ${dataset.ftpLink || "Not available"}

User Intent / Criteria:
${userPrompt}

Expected Tags to choose from (you can add others if highly relevant, but prefer these):
${expectedTags}

Evaluate this dataset based on the User Intent.
Return ONLY a valid JSON object (no markdown formatting, no backticks) with this exact structure:
{
  "decision": "include" | "exclude" | "unclear",
  "score": number (0-100),
  "reasoning": "string (cite metadata)",
  "tags": ["tag1", "tag2"]
}
`.trim();
}

function extractJson(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  const candidate = m ? m[0] : text;
  const parsed = JSON.parse(candidate);
  const score = typeof parsed.score === "number" ? parsed.score : parseInt(String(parsed.score ?? ""), 10);
  if (!parsed.decision || Number.isNaN(score)) {
    throw new Error(`Missing required fields in JSON: ${candidate.slice(0, 200)}...`);
  }
  return {
    decision: parsed.decision as "include" | "exclude" | "unclear",
    score,
    reasoning: String(parsed.reasoning ?? "No reasoning provided."),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : []
  };
}

async function callChat(provider: Provider, apiKey: string, body: any, timeoutMs: number) {
  await throttleLLM(provider);
  console.log(`[THROTTLE] sending request provider=${provider} at ${new Date().toISOString()}`);

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(`${API_BASE}/api/llm/chat`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "x-provider": provider,
        "x-api-key": apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new HttpError(r.status, t);
    }

    return await r.json();
  } finally {
    clearTimeout(id);
  }
}

async function evaluateOne(dataset: GeoResult, task: Task) {
  const prompt = buildPrompt(dataset, task.llmPrompt, task.expectedTags);

  const providerOrder: Provider[] =
    task.strategy === "saia_only" ? ["saia"] :
    task.strategy === "openrouter_only" ? ["openrouter"] :
    task.strategy === "openrouter_then_saia" ? ["openrouter", "saia"] :
    ["saia", "openrouter"];

  const timeoutMs = task.perModelTimeoutMs ?? 30000;
  let lastErr: any = null;

  for (const provider of providerOrder) {
    const apiKey = provider === "saia" ? SAIA_KEY : OPENROUTER_KEY;
    if (!apiKey) {
      console.log(`[LLM] skip ${provider} (no API key in env)`);
      continue;
    }

    const models = provider === "saia" ? task.saiaModels : task.openRouterModels;

    for (const model of models) {
      try {
        const data = await callChat(provider, apiKey, {
          model,
          messages: [
            { role: "system", content: "You are a strict JSON-only API. You must output raw JSON without markdown formatting." },
            { role: "user", content: prompt }
          ],
          temperature: 0,
          ...(provider === "openrouter" ? { response_format: { type: "json_object" } } : {})
        }, timeoutMs);

        const text = data.choices?.[0]?.message?.content || "";
        const modelUsed = data.model || model;

        const parsed = extractJson(text);
        return {
          llmDecision: parsed.decision,
          llmScore: parsed.score,
          llmReasoning: parsed.reasoning,
          llmTags: parsed.tags,
          llmModelUsed: `${provider}:${modelUsed}`
        };
      } catch (e: any) {
        lastErr = e;
        if (e instanceof HttpError && e.status === 429) {
          console.log(`[LLM] ${provider} rate-limited (HTTP 429). Backing off ${BACKOFF_429_MS}ms...`);
          await sleep(BACKOFF_429_MS);
        }
        const detail = e instanceof HttpError ? `${e.message}: ${e.body}` : e?.message ?? String(e);
        console.log(`[LLM] ${provider} ${model} failed: ${detail}`);
      }
    }
  }

  return {
    llmDecision: "unclear" as const,
    llmScore: 0,
    llmReasoning: `Failed to evaluate. Last error: ${lastErr?.message ?? "unknown"}`,
    llmTags: ["error"],
    llmModelUsed: "None"
  };
}

// ---- output ----
function csvEscape(x: any) {
  const s = String(x ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(outPath: string, rows: GeoResult[]) {
  const headers = ['GSE_ID', 'Title', 'Organism', 'Assay', 'Samples', 'Decision', 'Score', 'Tags', 'Reasoning', 'PMID', 'FTP_Link'];
  const lines = [headers.join(",")];

  for (const r of rows) {
    lines.push([
      csvEscape(r.gseId),
      csvEscape(r.title),
      csvEscape(r.organism),
      csvEscape(r.assay),
      csvEscape(r.n_samples),
      csvEscape(r.llmDecision || ""),
      csvEscape(r.llmScore ?? ""),
      csvEscape((r.llmTags || []).join(", ")),
      csvEscape(r.llmReasoning || ""),
      csvEscape(r.pmid || ""),
      csvEscape(r.ftpLink || "")
    ].join(","));
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
}

// ---- main ----
async function main() {
  const { taskPath, outPath } = parseArgs();
  const task: Task = JSON.parse(fs.readFileSync(taskPath, "utf-8"));

  // Apply task config
  SAIA_MIN_INTERVAL_MS = task.saiaMinIntervalMs ?? 3000;
  OPENROUTER_MIN_INTERVAL_MS = task.openrouterMinIntervalMs ?? 800;
  BACKOFF_429_MS = task.rateLimitBackoffMs ?? 15000;

  const ncbiDelayMs = task.ncbiDelayMs ?? 340;
  const concurrencyContext = task.concurrencyContext ?? 3;
  const concurrencyLLM = task.concurrencyLLM ?? 1;

  console.log(`[TASK] ${task.name}`);
  console.log(`[API]  ${API_BASE}`);
  console.log(`[PIPE] ctx=${concurrencyContext} llm=${concurrencyLLM}  |  SAIA=${SAIA_MIN_INTERVAL_MS}ms OR=${OPENROUTER_MIN_INTERVAL_MS}ms backoff=${BACKOFF_429_MS}ms`);

  if (!SAIA_KEY && !OPENROUTER_KEY) usageAndExit("No API keys provided. Set SAIA_API_KEY and/or OPENROUTER_API_KEY.");

  const ids = await searchGeo(task.query, task.maxResults, task.minDate, task.maxDate);
  console.log(`[NCBI] got ${ids.length} ids`);

  let datasets = await fetchGeoSummaries(ids, ncbiDelayMs);
  console.log(`[NCBI] fetched summaries for ${datasets.length} datasets`);

  // hard filters
  const org = (task.organism ?? "").toLowerCase();
  const assay = (task.assay ?? "").toLowerCase();
  const minS = task.minSamples ?? 0;

  datasets = datasets.filter(d => {
    if (org && !String(d.organism ?? "").toLowerCase().includes(org)) return false;
    if (assay && !String(d.assay ?? "").toLowerCase().includes(assay)) return false;
    if (minS > 0 && (d.n_samples ?? 0) < minS) return false;
    return true;
  });

  console.log(`[FILTER] remaining after hard filters: ${datasets.length}`);

  // Pipeline:
  // - CTX producers push completed items into queue
  // - LLM consumers pop and score them (rate-limited), writing results array
  const q = new AsyncQueue<{ idx: number; data: GeoResult }>();
  const out: GeoResult[] = new Array(datasets.length) as any;

  let ctxDone = 0;

  const ctxWorkers = Array.from({ length: Math.max(1, concurrencyContext) }, (_, w) => (async () => {
    for (;;) {
      const idx = ctxDone++;
      if (idx >= datasets.length) return;

      const d = datasets[idx];
      console.log(`[CTX] ${idx + 1}/${datasets.length} ${d.gseId}`);

      const { overallDesign, primaryPmid } = await fetchGeoDesignAndPrimaryPmid(d.gseId, 3);
      const withDesign: GeoResult = { ...d, overallDesign };

      await sleep(ncbiDelayMs);

      if (primaryPmid) {
        withDesign.pmid = primaryPmid;
        withDesign.paperAbstract = await fetchPubMedAbstract(primaryPmid, 3);
        await sleep(ncbiDelayMs);
      }

      q.push({ idx, data: withDesign });
    }
  })());

  const llmWorkers = Array.from({ length: Math.max(1, concurrencyLLM) }, (_, w) => (async () => {
    for (;;) {
      const item = await q.pop();
      if (!item) return;

      const { idx, data } = item;
      console.log(`[LLM] ${idx + 1}/${datasets.length} ${data.gseId} (queued)`);

      const evalRes = await evaluateOne(data, task);
      out[idx] = { ...data, ...evalRes };

      console.log(`[LLM] ${data.gseId} -> ${out[idx].llmDecision} score=${out[idx].llmScore} model=${out[idx].llmModelUsed}`);
    }
  })());

  // Wait for CTX to finish, then close queue, then wait for LLM workers
  await Promise.all(ctxWorkers);
  q.close();
  await Promise.all(llmWorkers);

  const finalRows = out.filter(Boolean);
  finalRows.sort((a, b) => (b.llmScore ?? 0) - (a.llmScore ?? 0));
  writeCsv(outPath, finalRows);

  console.log(`[WROTE] ${outPath}`);
}

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
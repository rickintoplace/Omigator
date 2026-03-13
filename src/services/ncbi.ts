export interface GeoResult {
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
}

const SERVER_BASE = "http://127.0.0.1:8787";

function viaNcbiProxy(url: string) {
  return `/api/ncbi?url=${encodeURIComponent(url)}`;
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

export async function gseToGdsId(gseId: string): Promise<string | null> {
  const term = encodeURIComponent(`${gseId}[Accession]`);
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gds&term=${term}&retmode=json&retmax=5`;
  const res = await fetch(viaNcbiProxy(url));
  if (!res.ok) throw new Error(`gseToGdsId failed: ${res.statusText}`);
  const data = await res.json();
  const ids: string[] = data.esearchresult?.idlist || [];
  return ids.length > 0 ? ids[0] : null;
}

export async function gseListToGdsIdsBatch(
  gseIds: string[],
  signal?: AbortSignal,
  chunkSize: number = 80
): Promise<string[]> {
  const normalized = Array.from(
    new Set(
      gseIds
        .map((x) => x.trim().toUpperCase())
        .filter((x) => /^GSE\d+$/.test(x))
    )
  );

  if (normalized.length === 0) return [];

  const out: string[] = [];

  for (let i = 0; i < normalized.length; i += chunkSize) {
    if (signal?.aborted) throw new Error("Aborted by user");

    const chunk = normalized.slice(i, i + chunkSize);
    const orTerm = chunk.map((gse) => `${gse}[Accession]`).join(" OR ");
    const term = `(${orTerm}) AND gse[entry type]`;

    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gds&term=${encodeURIComponent(
      term
    )}&retmode=json&retmax=100000`;

    const res = await fetch(viaNcbiProxy(url), { signal });
    if (!res.ok) throw new Error(`gseListToGdsIdsBatch failed: ${res.statusText}`);
    const data = await res.json();

    const ids: string[] = data.esearchresult?.idlist || [];
    out.push(...ids);

    await new Promise((r) => setTimeout(r, 340));
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of out) {
    if (!seen.has(id)) {
      deduped.push(id);
      seen.add(id);
    }
  }
  return deduped;
}

export async function searchGeo(
  query: string,
  maxResults: number = 10,
  minDate?: string,
  maxDate?: string,
  signal?: AbortSignal
): Promise<string[]> {
  let term = `${query} AND gse[entry type]`;
  if (minDate || maxDate) {
    const min = minDate ? minDate.replace(/-/g, "/") : "1000/01/01";
    const max = maxDate ? maxDate.replace(/-/g, "/") : "3000/01/01";
    term += ` AND ("${min}"[Publication Date] : "${max}"[Publication Date])`;
  }

  const encodedTerm = encodeURIComponent(term);
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gds&term=${encodedTerm}&retmode=json&retmax=${maxResults}`;

  const response = await fetch(viaNcbiProxy(url), { signal });
  if (!response.ok) throw new Error(`NCBI Search failed: ${response.statusText}`);

  const data = await response.json();
  return data.esearchresult?.idlist || [];
}

export async function fetchPubMedAbstract(
  pmid: string,
  retries = 3,
  signal?: AbortSignal
): Promise<string> {
  try {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`;
    const res = await fetch(viaNcbiProxy(url), { signal });

    if (res.status === 429 && retries > 0) {
      await new Promise((r) => setTimeout(r, 1000));
      return fetchPubMedAbstract(pmid, retries - 1, signal);
    }

    const text = await res.text();
    const matches = text.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g);
    if (matches) {
      return matches.map((m) => m.replace(/<[^>]+>/g, "")).join(" ");
    }
    return "No abstract available.";
  } catch (e: any) {
    if (e.name === "AbortError") throw e;
    return "Failed to fetch abstract.";
  }
}

export async function fetchGeoDesignAndPrimaryPmid(
  gseId: string,
  retries = 3,
  signal?: AbortSignal
): Promise<{ overallDesign: string; primaryPmid?: string }> {
  try {
    const url = `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${gseId}&targ=self&form=text&view=quick`;
    const res = await fetch(viaNcbiProxy(url), { signal });

    if (res.status === 429 && retries > 0) {
      await new Promise((r) => setTimeout(r, 1000));
      return fetchGeoDesignAndPrimaryPmid(gseId, retries - 1, signal);
    }

    const text = await res.text();

    const designMatches = text.match(/!Series_overall_design = (.*)/g);
    const overallDesign = designMatches
      ? designMatches.map((m) => m.replace("!Series_overall_design = ", "").trim()).join(" ")
      : "No overall design available.";

    const pmidMatch = text.match(/!Series_pubmed_id = (\d+)/);
    const primaryPmid = pmidMatch ? pmidMatch[1] : undefined;

    return { overallDesign, primaryPmid };
  } catch (e: any) {
    if (e.name === "AbortError") throw e;
    return { overallDesign: "Failed to fetch overall design.", primaryPmid: undefined };
  }
}

export async function fetchGeoSummaries(ids: string[], signal?: AbortSignal): Promise<GeoResult[]> {
  if (ids.length === 0) return [];

  const results: GeoResult[] = [];
  const chunkSize = 50;

  for (let i = 0; i < ids.length; i += chunkSize) {
    if (signal?.aborted) throw new Error("Aborted by user");

    const chunk = ids.slice(i, i + chunkSize);

    const url =
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi` +
      `?db=gds&id=${chunk.join(",")}&retmode=xml`;

    const response = await fetch(viaNcbiProxy(url), { signal });
    if (!response.ok) throw new Error(`NCBI Summary fetch failed: ${response.statusText}`);

    const xml = await response.text();
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
        pmid,
        ftpLink: undefined,
      });
    }

    if (i + chunkSize < ids.length) await new Promise((r) => setTimeout(r, 340));
  }

  return results;
}
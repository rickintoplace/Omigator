/**
 * GEO series records in SOFT format.
 *
 * Primary source: the FTP family file (`…/soft/GSExxx_family.soft.gz`): series plus all samples,
 * a few KB, CORS-enabled and not behind the browser check that guards most of www.ncbi.nlm.nih.gov.
 * Fallback: `acc.cgi?targ=all&view=brief` (same content without data tables), with detection of
 * HTML/captcha responses.
 */

import { type Fetch, HttpError, request } from './http.js';
import type { Sample, Series } from './types.js';

export interface SoftEntity {
  type: string;
  id: string;
  attrs: Map<string, string[]>;
}

export function parseSoft(text: string): SoftEntity[] {
  const entities: SoftEntity[] = [];
  let current: SoftEntity | undefined;
  let inTable = false;

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('^')) {
      const [type, id = ''] = line.slice(1).split(' = ');
      current = { type: type.trim().toUpperCase(), id: id.trim(), attrs: new Map() };
      entities.push(current);
      inTable = false;
      continue;
    }
    if (!current || !line.startsWith('!')) continue;
    if (/_table_begin$/.test(line)) {
      inTable = true;
      continue;
    }
    if (/_table_end$/.test(line)) {
      inTable = false;
      continue;
    }
    if (inTable) continue;
    const eq = line.indexOf(' = ');
    const key = (eq === -1 ? line.slice(1) : line.slice(1, eq)).trim();
    const value = eq === -1 ? '' : line.slice(eq + 3).trim();
    const list = current.attrs.get(key);
    if (list) list.push(value);
    else current.attrs.set(key, [value]);
  }
  return entities;
}

const first = (e: SoftEntity, key: string) => e.attrs.get(key)?.[0] ?? '';
const all = (e: SoftEntity, key: string) => e.attrs.get(key) ?? [];
const joined = (e: SoftEntity, key: string) => all(e, key).filter(Boolean).join(' ');

function toSample(e: SoftEntity): Sample {
  const characteristics: Record<string, string> = {};
  for (const ch of ['ch1', 'ch2']) {
    for (const raw of all(e, `Sample_characteristics_${ch}`)) {
      if (!raw) continue;
      const colon = raw.indexOf(':');
      let key = colon > 0 ? raw.slice(0, colon).trim().toLowerCase() : 'characteristic';
      const value = colon > 0 ? raw.slice(colon + 1).trim() : raw.trim();
      if (ch === 'ch2') key = `${key} (ch2)`;
      characteristics[key] = characteristics[key] ? `${characteristics[key]}; ${value}` : value;
    }
  }
  return {
    gsm: e.id,
    title: first(e, 'Sample_title'),
    source: [first(e, 'Sample_source_name_ch1'), first(e, 'Sample_source_name_ch2')].filter(Boolean).join(' / '),
    organisms: [...new Set([...all(e, 'Sample_organism_ch1'), ...all(e, 'Sample_organism_ch2')])].filter(Boolean),
    characteristics,
    libraryStrategy: first(e, 'Sample_library_strategy') || undefined,
    librarySource: first(e, 'Sample_library_source') || undefined,
    molecule: first(e, 'Sample_molecule_ch1') || undefined,
    description: joined(e, 'Sample_description') || undefined,
    treatmentProtocol: joined(e, 'Sample_treatment_protocol_ch1') || undefined,
    growthProtocol: joined(e, 'Sample_growth_protocol_ch1') || undefined,
  };
}

/** `!Series_relation = SuperSeries of: GSE52695` → ['GSE52695'] */
function relations(e: SoftEntity, kind: string): string[] {
  return all(e, 'Series_relation')
    .filter((r) => r.startsWith(`${kind}:`))
    .map((r) => r.slice(kind.length + 1).trim())
    .filter((g) => /^GSE\d+$/.test(g));
}

export function seriesFromSoft(text: string, gse: string, origin: Series['origin']): Series {
  const entities = parseSoft(text);
  const s = entities.find((e) => e.type === 'SERIES' && e.id === gse) ?? entities.find((e) => e.type === 'SERIES');
  if (!s) throw new Error(`No series record for ${gse} in GEO response`);
  return {
    gse: s.id || gse,
    title: first(s, 'Series_title'),
    summary: joined(s, 'Series_summary'),
    overallDesign: joined(s, 'Series_overall_design'),
    types: all(s, 'Series_type'),
    pmids: all(s, 'Series_pubmed_id').filter((x) => /^\d+$/.test(x)),
    platforms: all(s, 'Series_platform_id'),
    supplementaryFiles: all(s, 'Series_supplementary_file').map((u) => u.split('/').pop() ?? u),
    superSeriesOf: relations(s, 'SuperSeries of'),
    subSeriesOf: relations(s, 'SubSeries of'),
    samples: entities.filter((e) => e.type === 'SAMPLE').map(toSample),
    origin,
  };
}

export function familyFileUrl(gse: string): string {
  const digits = gse.replace(/^GSE/i, '');
  const stub = digits.length > 3 ? `GSE${digits.slice(0, -3)}nnn` : 'GSEnnn';
  return `https://ftp.ncbi.nlm.nih.gov/geo/series/${stub}/${gse}/soft/${gse}_family.soft.gz`;
}

export class GeoBlockedError extends Error {}

export interface SeriesFetchOptions {
  fetch?: Fetch;
  signal?: AbortSignal;
  /** Family files above this compressed size (array data tables) go to the web endpoint instead. */
  maxFtpBytes?: number;
}

async function gunzipText(res: Response): Promise<string> {
  const stream = res.body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export async function fetchSeries(gse: string, opts: SeriesFetchOptions = {}): Promise<Series> {
  const { signal, maxFtpBytes = 2_000_000 } = opts;
  let ftpError: unknown;

  try {
    const res = await request(familyFileUrl(gse), {}, { signal, fetch: opts.fetch, retries: 1, timeoutMs: 30_000 });
    const size = Number(res.headers.get('content-length'));
    if (Number.isFinite(size) && size > maxFtpBytes) {
      await res.body?.cancel();
      throw new Error(`family file too large (${size} bytes)`);
    }
    return seriesFromSoft(await gunzipText(res), gse, 'ftp');
  } catch (err) {
    if (signal?.aborted) throw err;
    ftpError = err;
  }

  const url = `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${gse}&targ=all&form=text&view=brief`;
  const res = await request(url, {}, { signal, fetch: opts.fetch, retries: 2, timeoutMs: 45_000 });
  const text = await res.text();
  if (/^\s*</.test(text) || /recaptcha|checking your browser/i.test(text.slice(0, 4000))) {
    throw new GeoBlockedError(
      `GEO returned a browser check instead of data for ${gse} (FTP: ${(ftpError as Error)?.message ?? ftpError}).`,
    );
  }
  if (!text.includes('^SERIES')) {
    const status = ftpError instanceof HttpError ? ftpError.status : 'n/a';
    throw new Error(`GEO has no record for ${gse} (FTP status ${status}).`);
  }
  return seriesFromSoft(text, gse, 'web');
}

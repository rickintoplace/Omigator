# Omigator | Find GEO datasets that actually fit

[![DOI](https://zenodo.org/badge/1181290758.svg)](https://doi.org/10.5281/zenodo.19020074)

<p align="center">
  <img src="./src/assets/omigator-logo.png" alt="Omigator logo" width="420" />
</p>

<p align="center">
  <strong>From one sentence to a ranked, evidence-backed shortlist of NCBI GEO datasets.</strong><br/>
  Runs in your browser. No account, no server, no data kept.
</p>

**Try it:** **https://omigator.rickinto.place** → *Watch a recorded run*. You don't need a key for the demo.

<p align="center">
  <img src="./docs/omigator-demo.gif" alt="A real Omigator run: one sentence becomes a GEO search and a checklist, 174 datasets are screened, and the top hit is explained with quotes checked against the GEO record" width="960" />
</p>
<p align="center"><sub>A real run, recorded on 2026-10-29 (waiting times sped up; screening cost $0.007).</sub></p>

---

## What it does

1. **Describe** what you need in a sentence, in any language. Omigator drafts a GEO search with
   synonyms and a checklist of criteria. Both stay editable.
2. **Screen.** Each candidate series is checked against every criterion. The check reads the series
   text, the **sample annotations** (conditions, controls, replicates, protocols) and the linked abstract.
3. **Decide.** You get a ranked list with *include / unclear / exclude* and a probability per criterion.
   On request you also get explanations whose quotes are checked word for word against the record, with a
   link to where each one stands, and a second check whether the quotes support the verdict.
   Export to CSV, or as a run file you can cite in a methods section.

Things you can do with the results:

- **Share a link.** The link holds the ranking, the probabilities, your marks and (space permitting)
  the explanations. Whoever opens it sees the same list without a key; sample details are fetched
  from GEO when they open a dataset. Nothing is uploaded anywhere: the run lives in the link itself.
- **Come back later.** Every run is saved in your browser and listed on the start page, and the
  address bar points to it, so a reload or a misclick loses nothing.
- Mark datasets 👍 or 👎. Omigator then estimates how many relevant datasets the decisions keep,
  and how far down the list you need to read to keep 90–99% of them.
- Paste the GSE list of a published meta-analysis to see how well the ranking matches it.

## How it works

| Step | What happens | Why |
|---|---|---|
| Search | NCBI E-utilities (`db=gds`). Filters (organism, dates) are part of the query. | Filtering in the query keeps your result limit for datasets that can match. |
| Evidence | GEO *family* SOFT file per series, loaded from the GEO FTP site. The per-sample annotations are condensed into a **design table** (e.g. `o2: hypoxic \| siRNA: siARNT (n=3)`), plus protocols and the linked abstract. | Replicates, controls and exposure times are usually only stated per sample. |
| Screening | A **decision model** (default `perplexity/pplx-decider-v1.2`, open weights). One request per dataset returns a probability for every criterion. | It reads probabilities instead of asking the model to *write* a score. Verbalized 0–100 scores cluster and are poorly calibrated. |
| Decision | Done in code, not by the model. *Exclude* if a must-criterion clearly fails. *Include* if all must-criteria pass. Otherwise *unclear*. Ranking = sum of log-probabilities. | Auditable, and AND stays AND. |
| Explanations | On demand, a chat model (default DeepSeek V4.1 Flash) answers each criterion with verbatim quotes. [VeriQuote](https://github.com/rickintoplace/veriquote) checks each quote twice. First: is it in the record? It is searched in the series text, each sample and the linked abstract, and the result links to the one it came from; quotes it cannot find are flagged. Lines Omigator computed (sample groups with n, counts) are labelled *computed* and list the samples behind them, never passed off as record text. Second: does it support the verdict? The decision model judges each one. | No invented justifications, and no computed fact presented as a quote. |
| Calibration | Platt scaling and a split-conformal cut-off, both fitted on your labels. | Model probabilities are not calibrated for your question. |

Each run uses **one model**, and the dated snapshot that served it is stored in the run file. If a
dataset fails, it is reported as failed. Omigator never quietly re-scores it with another model.

## Benchmark

The benchmark uses the search and inclusion criteria of the hypoxia meta-analysis by
Puente-Santamaria et al. (2022). After filters there are 187 candidates, and 44 of the paper's 46
datasets are among them. Datasets the paper did not include count as negatives, so precision is a
lower bound. Full table and caveats: [`eval/RESULTS.md`](eval/RESULTS.md).

| | "include": precision / recall | AUROC | work saved at 95% recall |
|---|---|---|---|
| v0.1 (chat model, verbal 0–100 score) | 0.42 / 0.98 | – | – |
| v0.2, paper's criteria, series text only | 0.75 / **0.48** | 0.92 | 52% |
| **v0.2, paper's criteria, with sample annotations** | **0.60 / 0.93** | **0.93** | **58%** |

Most of the remaining "false positives" are eligible. 60 datasets were checked by hand against the
paper's criteria ([`eval/adjudication/`](eval/adjudication/)). Measured against the reference list plus
the datasets found eligible, precision at *include* is **0.84** at recall 0.92. Many of the extra
finds are GEO SuperSeries that bundle a listed dataset, and Omigator now hides these duplicates.

The 187 datasets cost less than one cent to screen and took about a minute.

## Using it

**Free, without a key.** Open the app and go. The free tier covers up to 1,000 datasets, 20
explanations and 20 drafts a day per device, with fixed models. It needs your agreement first: to
share it fairly, your browser sends a hash of a coarse device signature, as the app explains next
to the button. When the day's budget is spent, the free tier pauses until the next day.

**With your own key.** Add an [OpenRouter key](https://openrouter.ai/keys) under *Settings* for no
limits and your choice of models. Nothing is collected then. A few dollars of credit last for many
thousands of datasets.

**Self-hosted models.** Under *Settings → Your own endpoint* you can point Omigator at any
OpenAI-compatible server that returns logprobs: vLLM, llama.cpp, Ollama or an institute gateway.
The browser calls that server directly, so the server must allow the page's origin:

```bash
vllm serve <model> --allowed-origins '["https://omigator.rickinto.place"]'
OLLAMA_ORIGINS=https://omigator.rickinto.place ollama serve
```

**Hosting the app yourself.** It is a static site: `npm run build`, then serve `dist/` from any web
server, GitHub Pages or Vercel. The free tier is optional; how to set it up is described at the top
of [`server/freeTier.ts`](server/freeTier.ts).

### Privacy

The full privacy notice and imprint are at [`/legal.html`](legal.html) (linked from the app). Fonts
are bundled; the app makes no requests to Google or analytics services.

- Dataset metadata (series text, sample annotations, abstracts) is sent to the model provider you choose.
- API keys go only to that provider. They are kept in the browser only if you tick *Remember keys*.
- On the free tier, the request text, checklist and accession numbers go through Omigator's server
  to OpenRouter. The key stays on that server, which builds every prompt itself from the GEO record.
  Only a daily usage count is kept, under a pseudonym, in memory.
- GEO records and model answers are cached in your browser (IndexedDB). Clear the cache in *Settings*.

## Command line and evaluation

The CLI uses the same core as the web app:

```bash
npm install
echo "OPENROUTER_API_KEY=sk-or-..." > .env         # git-ignored
npm run eval -- --task eval/tasks/hypoxia-paper-criteria.json
npm run eval -- --task eval/tasks/hypoxia-paper-criteria.json --evidence series   # ablation
npm run eval -- --task eval/tasks/hypoxia.json --explain 20                        # with explanations
```

A task file holds the protocol (query, filters, criteria), the scorer and, optionally, a reference
list. Each run writes `manifest.json`, `metrics.json` and `results.csv` to `eval/runs/`. Model calls
are cached in `eval/.cache/`, so reruns are free. `npm run make-demo` re-records the demo from that cache.

## Development

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # unit tests (parsers, design inference, decisions, metrics, calibration)
npm run typecheck
```

```
src/core/   search, GEO records, evidence, models, screening, decisions, calibration, metrics (browser + Node)
src/ui/     React app
server/     free tier (key stays on the server); api/ holds its Vercel Function
eval/       CLI, benchmark tasks, results, pilot, demo recorder
test/       unit tests with real GEO/PubMed fixtures
```

## Citing

Please cite the Zenodo record: https://doi.org/10.5281/zenodo.19020074 (see `CITATION.cff`).

## Acknowledgements and references

- Data: [NCBI GEO](https://www.ncbi.nlm.nih.gov/geo/) and [E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/). Please respect NCBI's usage policies.
- Models through [OpenRouter](https://openrouter.ai). Default decision model: Perplexity pplx-decider (Apache-2.0).
- Quote checking: [VeriQuote](https://github.com/rickintoplace/veriquote).
- Benchmark reference: Puente-Santamaria, L., Sanchez-Gonzalez, L., Pescador, N., Martinez-Costa, O., Ramos-Ruiz, R., & Del Peso, L. (2022). *Formal Meta-Analysis of Hypoxic Gene Expression Profiles Reveals a Universal Gene Signature*. Biomedicines, 10(9), 2229. https://doi.org/10.3390/biomedicines10092229

## Disclaimer

Omigator makes recommendations from metadata. Check every inclusion decision in the GEO record and
the associated publication.

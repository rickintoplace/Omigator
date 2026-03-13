# Omigator | AI Omics Dataset Gating

---

<p align="center">
  <img src="src/assets/omigator-logo.png" alt="Omigator logo" width="420" />
</p>

<p align="center">
  <strong>Stop drowning in GEO results. Actually find relevant data.</strong><br/>
  Built for researchers. Friendly for non-technical users. Hackable for developers.
</p>

---

# What you get
- A **ranked shortlist** (not just search results)
- **Include/exclude/unclear** decisions with a **0–100 score**
- **Transparent reasoning + tags** you can audit and report

## Live Demo (no install)
For a quick test or if you don't know how you came here:

**https://omigator.vercel.app**

You will need your own API key(s) (see below). Keys are not stored by Omigator.

---

## What Omigator does
Omigator helps you find and triage GEO datasets efficiently:

- Search NCBI GEO (or paste a list of GSE accessions)
- Apply hard filters (organism, assay, min samples, date range)
- Fetch additional context (Overall Design, PubMed abstract if available)
- Score and label datasets using an LLM:
  - `include` / `exclude` / `unclear`
  - numeric score (0–100)
  - reasoning and tags
- Export results as CSV
- Optional self-evaluation vs. a “gold standard” list of GSE IDs

---

## Supported LLM providers (bring your own key)
Omigator supports:
- **SAIA (GWDG chat-ai)** (OpenAI-compatible endpoint)
   https://docs.hpc.gwdg.de/services/ai-services/saia/index.html
- **OpenRouter**

You can use either provider alone, or configure fallback:
- **SAIA → OpenRouter**
- **OpenRouter → SAIA**
- **SAIA only**
- **OpenRouter only**

### Privacy note (important)
- Omigator forwards *dataset metadata text* (title/summary/design/abstract) to the selected LLM provider.
- If you use Omigator via https://omigator.vercel.app, your API keys are sent per request to the backend. They are **not persisted** by Omigator.

---

## Repository layout (dual-mode: Vercel + local Express)
This repo supports:
- **Vercel deployment** via serverless functions in `/api`
- **Local development** using Vite + a lightweight Express dev API

```
api/                  # Vercel serverless functions (prod)
server/               # local Express dev API (dev)
src/                  # React app
```

---

## Quick start (developers)

### Requirements
- Node.js 18+ (Node 20+ recommended)
- npm

### Install
```bash
npm install
```

### Run locally (Windows/macOS/Linux)
Starts:
- Express API on `http://127.0.0.1:8787`
- Vite web app on `http://localhost:3000`

```bash
npm run dev
```

Open the printed URL (usually `http://localhost:3000`).

---

## Build (frontend)
```bash
npm run build
```

This produces a static build in `dist/`.

---

## Deploy

### Option A (recommended for non-technical users): Vercel
The public instance is available at:
- **https://omigator.vercel.app**

To deploy your own instance:
1. Import this repository in Vercel
2. Framework: **Vite**
3. Build command: `npm run build`
4. Output directory: `dist`
5. Ensure `vercel.json` is included (sets function timeouts)

Vercel will automatically deploy:
- the static frontend
- the serverless API endpoints in `/api/*`

### Option B: Self-host (advanced / institutional)
If you want a self-hosted instance (e.g., institute server), you can run a Node server that serves the built UI and provides `/api/*`.
See `src/server.ts` (Node self-host server). Typical steps:

```bash
npm install
npm run build
# run the node server (adjust PORT as needed)
PORT=8787 npm run start:node
```

Then open:
- `http://<host>:8787`

---

## Configuration & API keys (user UI)
Omigator is designed so users can paste their key(s) directly in the UI:
- SAIA API Key
- OpenRouter API Key
- Fallback strategy selector

No `.env` keys are required for normal usage.

---

## Citing Omigator
If you use Omigator in a publication, please cite the Omigator tool paper:

> (TODO: add citation details/DOI once published)

---

## Contributing
Issues and PRs are welcome:
- bug reports (include steps + screenshots if possible)
- new model/provider adapters
- evaluation datasets and prompts
- UX improvements for non-technical users

---

## Acknowledgements & third-party services

### LLM providers
Omigator can route LLM requests through external providers (user-supplied API keys), including:

- **GWDG Chat AI / SAIA** — Doosthosseini et al. (2025). *SAIA: A Seamless Slurm-Native Solution for HPC-Based Services*. Research Square. https://doi.org/10.21203/rs.3.rs-6648693/v1  
  (BibTeX: see `CITATION.bib`)
- **OpenRouter** — https://openrouter.ai (accessed 2025-03-12)

### Data sources
Omigator retrieves dataset metadata from **NCBI GEO** using **NCBI Entrez E-utilities** and related GEO endpoints.
Please comply with NCBI usage policies and rate limits.

- NCBI GEO: https://www.ncbi.nlm.nih.gov/geo/
- NCBI E-utilities: https://www.ncbi.nlm.nih.gov/books/NBK25501/

---

## Disclaimer
Omigator provides *recommendations* based on metadata and LLM output. Always verify inclusion/exclusion decisions in the original GEO record and associated publication.
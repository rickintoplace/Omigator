# Evaluation results

All runs: `npm run eval -- --task <task> [--evidence series]`. Each run directory holds
`manifest.json` (protocol, model snapshot, counts, cost), `metrics.json` and `results.csv`
(per-criterion probabilities). Model calls are cached in `eval/.cache/`.

## Hypoxia benchmark (2026-10-19)

Search, filters and date cut-off as in Puente-Santamaria et al. (2022), *Biomedicines* 10(9):2229,
doi:10.3390/biomedicines10092229: 187 candidates after filters, 44 of the paper's 46 included GSEs
among them. Positives = the paper's included GSEs; everything else counts as negative, so precision
is a lower bound (silver standard).

Screening model: `perplexity/pplx-decider-v1.2` (snapshot `-20261016`), one Decisions API request per
dataset with all criteria. Cost per run: < $0.01 for 187 datasets, ~1 min.

| setup | criteria | evidence | AUROC [95% CI] | AP | P@20 | R@50 | WSS@95 | include: precision / recall |
|---|---|---|---|---|---|---|---|---|
| v0.1 (glm-4.7, verbal 0–100) | 4, free-text prompt | series | – | – | 0.80 | 0.65 | – | 0.42 / 0.977 |
| v2 | 4 (`hypoxia.json`) | series only | 0.899 [0.849–0.944] | 0.724 | 0.80 | 0.70 | 0.50 | 0.44 / 0.955 |
| v2 | 4 (`hypoxia.json`) | series + samples | 0.876 [0.821–0.922] | 0.617 | 0.70 | 0.67 | 0.42 | 0.40 / 0.977 |
| v2 | 7, paper's methods (`hypoxia-paper-criteria.json`) | series only | 0.920 [0.875–0.955] | 0.764 | 0.85 | 0.74 | 0.52 | 0.75 / **0.477** |
| v2 | 7, paper's methods | series + samples | 0.928 [0.888–0.960] | 0.764 | 0.85 | 0.74 | 0.57 | 0.59 / 0.932 |
| **v2.1** | **7, paper's methods** | **series + samples, groups split by library type** | **0.927 [0.887–0.959]** | **0.763** | **0.85** | **0.74** | **0.58** | **0.60 / 0.932** |

What this shows:

- **The criteria decide precision.** The v0.1 prompt lacked three of the paper's criteria
  (biological replicates, exposure ≤ 48 h, steady-state RNA). With them, precision at the include
  decision rises from 0.40 to 0.59 at similar recall.
- **Those criteria need sample-level metadata.** Replicate counts and exposure times are mostly
  stated per sample; from the series text alone the model cannot confirm them and recall at the
  include decision collapses to 0.48.
- **With only the four broad criteria, sample metadata lowers the ranking metrics.** About 100
  datasets then reach p ≈ 1 on every criterion; their order is decided by saturated probabilities
  (the pplx-decider model card warns about this) and the silver standard does not reward it.
- Missed positives (3): two where the record states long exposures and the paper presumably used
  only a ≤ 48 h subset, one whose samples are all labelled "condition: hypoxia" with 0 h as baseline.
- Most of the 28 remaining "false positives" look eligible on reading (e.g. GSE52695: hypoxia vs
  normoxia, 6 h and 48 h, replicates). Adjudicating them would turn the silver standard into a gold one.

Pilot with series-level text only (`eval/pilot/`, before the v2 core): pplx-decider-v1.2 AUROC 0.906,
pplx-decider-flash-v1.2 0.894, DeepSeek V4.1 Flash logprobs 0.912 (Together only; unpinned OpenRouter
routing returned empty logprobs for 49 of 187 requests).

## Adjudicated reference (2026-10-19)

60 datasets of the v2 run were judged by hand against the paper's criteria. The method, the sample
and every verdict with its reason are in [`adjudication/`](adjudication/). Of the 28 datasets the model
included that were not on the reference list, 16 are eligible, 10 are not and 2 are uncertain; 12 of
the 16 are SuperSeries, most of them bundling a reference dataset. The random sample of 20 excluded
datasets held no eligible one.

Scored against the adjudicated reference (`hypoxia_gold_adjudicated.txt`, 64 datasets, 62 among the
candidates):

| setup | include: precision / recall | not excluded: precision / recall | AUROC | P@20 | P@50 |
|---|---|---|---|---|---|
| v2 (run that was adjudicated) | 0.826 / 0.919 | 0.759 / 0.968 | 0.963 | 0.90 | 0.90 |
| v2.1 (groups split by library type) | **0.838 / 0.919** | **0.800 / 0.968** | **0.966** | 0.90 | **0.92** |

Splitting sample groups by library type removed two of the replicate errors (GSE158601, GSE118363:
one RNA-seq plus one RIP-/miRNA-seq library per condition). Most of the remaining errors are
judgment calls: several cell lines counted as replicates (GSE93988, GSE101799), or hypoxia stated
only in sample titles (GSE90599).


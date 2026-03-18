## Task configuration
```json
{
  "name": "hypoxia_meta_analysis_like",
  "query": "hypoxia[Description] AND \"expression profiling by high throughput sequencing\"[DataSet Type]",
  "maxResults": 400,
  "maxDate": "2021-02-11",

  "organism": "Homo sapiens",
  "assay": "high throughput sequencing",
  "minSamples": 4,

  "llmPrompt": "You are screening GEO Series (GSE) for inclusion in a hypoxia bulk RNA-seq meta-analysis.\n\nPRIMARY GOAL: High recall (do not miss true positives), BUT also produce a USEFUL RANKING by using a wide score range (avoid giving 90-100 to almost everything).\n\nDecision meanings:\n- include = high-confidence match\n- unclear = plausible but missing key metadata; requires manual check\n- exclude = clearly not eligible\n\nINCLUDE only if CLEARLY supported by metadata:\nA) Bulk RNA-seq expression profiling (not scRNA-seq)\nB) Human in vitro cell-based experiment\nC) Hypoxia/anoxia by reduced oxygen tension AND a normoxia/baseline control exists\n\nUNCLEAR if the study looks relevant but ANY of A/B/C is not clearly stated.\n\nEXCLUDE only if clearly true:\n- scRNA-seq\n- non-human only\n- no control/baseline at all\n- chemical mimetic-only hypoxia without reduced oxygen\n- intermittent/cycling hypoxia only\n- clearly not bulk RNA-seq expression profiling\n\nSPECIAL CASE (for recall vs published gold standards):\n- If human samples are present and oxygen conditions are compared, treat as unclear or include (do NOT exclude) even if mixed-species or wording is imperfect.\n\nSTRICT SCORE CALIBRATION (must follow):\n- 95-100: textbook hypoxia vs normoxia bulk RNA-seq, clear in vitro human setup, clear replicates, clear timepoints\n- 80-94: strong match but one minor detail unclear (e.g., replicates not explicit)\n- 60-79: plausible hypoxia RNA-seq but key details missing/ambiguous (this should usually be decision='unclear')\n- 30-59: weak match / likely off-target\n- 0-29: clear exclude\n\nIMPORTANT: Only use tag include_meta_analysis when you are confident it truly fits; otherwise use unclear_* tags.\n\nReturn strict JSON only.",
  "expectedTags": "bulk_rnaseq, hypoxia, normoxia_control, in_vitro, include_meta_analysis, intervention_allowed, mixed_species, unclear_normoxia, unclear_hypoxia, unclear_in_vitro, unclear_bulk, unclear_species, unclear_timepoint, unclear_replicates, exclude_scRNA, exclude_nonhuman_only, exclude_no_normoxia, exclude_mimetic, exclude_intermittent, exclude_non_rnaseq_assay",

  "strategy": "saia_only",
  "saiaModels": [
    "glm-4.7"
  ],
  "openRouterModels": [],

  "perModelTimeoutMs": 30000,
  "ncbiDelayMs": 340,

  "concurrencyContext": 3,
  "concurrencyLLM": 1,

  "saiaMinIntervalMs": 6000,
  "openrouterMinIntervalMs": 0,
  "rateLimitBackoffMs": 60000
}
```

## Metrics (evaluate_omigator.py)
python eval/evaluate_omigator.py --csv eval/omigator_results.csv --gold eval/hypoxia_gold.txt --k 20,50,125
Rows (unique GSE): 187
Gold positives:     46

=== Decision-based (Decision == include) ===
{'tp': 43, 'fp': 60, 'fn': 1, 'tn': 83, 'precision': 0.4174757281553398, 'recall': 0.9772727272727273, 'f1': 0.5850340136054422}

=== Score-threshold evaluation ===
t=60: precision=0.381 recall=0.977 f1=0.548 (tp=43 fp=70 fn=1 tn=73)
t=70: precision=0.417 recall=0.977 f1=0.585 (tp=43 fp=60 fn=1 tn=83)
t=80: precision=0.417 recall=0.977 f1=0.585 (tp=43 fp=60 fn=1 tn=83)

=== Ranking metrics ===
Recall@20=0.348  Precision@20=0.800
Recall@50=0.652  Precision@50=0.600
Recall@125=0.935  Precision@125=0.344

=== Top FP tags (Decision-based) ===
bulk_rnaseq              60
hypoxia                  60
include_meta_analysis    60
in_vitro                 60
normoxia_control         57
intervention_allowed     11
unclear_replicates       11
unclear_timepoint         3
unclear_normoxia          2
mixed_species             1

=== Top FN tags (Decision-based) ===
hypoxia                     1
exclude_non_rnaseq_assay    1
in_vitro                    1
unclear_bulk                1

# Omigator evaluation run: Hypoxia meta-analysis (paper-based positives)

Date: 2026-03-14  
Omigator version: v0.1.1  
Provider/model: SAIA glm-4.7  
Task file: eval/tasks/hypoxia.json  
CSV output: eval/omigator_results.csv  
Gold positives: eval/hypoxia_gold.txt (46 GSE)

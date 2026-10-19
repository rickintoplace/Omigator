# Adjudication of the hypoxia benchmark

The hypoxia reference list (46 GSE included by Puente-Santamaria et al. 2022) only contains positives.
Every other dataset counts as negative, so the precision measured against it is a lower bound. To
find out how low, 60 datasets from the run `hypoxia-paper-criteria-perplexity_pplx-decider-v1.2-2026-10-19`
were judged by hand against the inclusion criteria stated in the paper's methods (section 2.2):

- human cells;
- steady-state total or poly(A) RNA;
- biological replicates;
- reduced oxygen tension (no chemical mimetics, no cyclic hypoxia);
- a normoxia control;
- exposure of at most 48 h.

## Sample

The sample was fixed before any record was read (`sample.json`, seed 20261019):

| group | what | n |
|---|---|---|
| A | not in the reference list, model said *include* (all) | 28 |
| B | not in the reference list, model said *unclear* (all) | 9 |
| C | not in the reference list, model said *exclude* (random 20 of 106) | 20 |
| D | in the reference list, model did not say *include* (all) | 3 |

The records were read in a shuffled order without the model's probabilities, from the same dossier
text the model saw (series, sample groups, protocols, abstract).

## Who judged

The adjudicator was Claude (Anthropic), working in the Omigator development session on 2026-10-19,
not a domain expert. The judgments are not fully blind: some datasets had been inspected earlier
during error analysis, among them the 3 datasets of group D and GSE52695. Each row in
`hypoxia-paper-criteria.csv` gives the verdict, the criterion that failed and a one-line reason, so
every call can be checked against the GEO record.

## Results

| group | eligible | not eligible | uncertain |
|---|---|---|---|
| A (model include) | 16 | 10 | 2 |
| B (model unclear) | 2 | 5 | 2 |
| C (model exclude, random) | 0 | 20 | 0 |
| D (reference, missed) | 3 | 0 | 0 |

- **SuperSeries.** 13 of the 21 eligible datasets are GEO SuperSeries. 10 of them bundle a dataset
  from the reference list, so they are the same samples under a second accession. Omigator now reads
  the SuperSeries/SubSeries relation from GEO and hides SuperSeries whose parts are already listed.
- **Failed criteria among model includes (group A).** Replicates 7, exposure > 48 h 1, no normoxia
  control 1, not human in vitro 1. Several replicate errors came from series that mix assays: an
  RNA-seq and a miRNA-seq library of the same condition looked like two replicates. Sample groups
  are now split by library type (see `eval/RESULTS.md` for the effect).
- **Missed reference datasets (group D).** All three are eligible. Two state long or unspecified
  exposures; one labels every sample "hypoxia" and uses 0 h as the normoxic baseline.

`../hypoxia_gold_adjudicated.txt` is the reference list plus the 18 datasets adjudicated eligible
that were not already in it. Datasets marked *uncertain* are left out.

## Limits

- Only groups A, B, C and D were adjudicated. The other 86 excluded non-reference datasets count as
  negative. With 0 of 20 eligible in the random sample, the 95% upper bound for eligible datasets
  among them is 14% (about 15 datasets).
- Adjudicating the model's own includes favours this run over other runs. A later run that includes
  datasets outside this sample is penalised if they are eligible. The adjudicated numbers are
  therefore best for comparing runs whose include sets are similar.

#!/usr/bin/env python3

# run example:
# python eval/evaluate_omigator.py --csv eval/omigator_results.csv --gold eval/hypoxia_gold.txt --k 20,50,125

import re
import argparse
import pandas as pd

def read_gold(path: str) -> set[str]:
    txt = open(path, "r", encoding="utf-8").read().upper()
    return set(re.findall(r"GSE\d+", txt))

def norm_gse(x: str) -> str:
    m = re.search(r"(GSE\d+)", str(x).upper())
    return m.group(1) if m else ""

def split_tags(tag_str: str) -> set[str]:
    if pd.isna(tag_str) or not str(tag_str).strip():
        return set()
    return set(t.strip() for t in str(tag_str).split(",") if t.strip())

def confusion(df: pd.DataFrame, gold: set[str], pred_pos_mask) -> dict:
    is_gold = df["GSE_ID"].isin(gold)
    pred_pos = pred_pos_mask

    tp = int((pred_pos & is_gold).sum())
    fp = int((pred_pos & ~is_gold).sum())
    fn = int((~pred_pos & is_gold).sum())
    tn = int((~pred_pos & ~is_gold).sum())

    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec  = tp / (tp + fn) if (tp + fn) else 0.0
    f1   = (2*prec*rec/(prec+rec)) if (prec+rec) else 0.0
    return {"tp":tp,"fp":fp,"fn":fn,"tn":tn,"precision":prec,"recall":rec,"f1":f1}

def recall_at_k(df_sorted: pd.DataFrame, gold: set[str], k: int) -> float:
    top = df_sorted.head(k)
    hit = top["GSE_ID"].isin(gold).sum()
    return float(hit) / float(len(gold)) if gold else 0.0

def precision_at_k(df_sorted: pd.DataFrame, gold: set[str], k: int) -> float:
    top = df_sorted.head(k)
    return float(top["GSE_ID"].isin(gold).sum()) / float(len(top)) if len(top) else 0.0

def tag_enrichment(df: pd.DataFrame, gold: set[str], pred_pos_mask):
    is_gold = df["GSE_ID"].isin(gold)
    pred_pos = pred_pos_mask

    fp = df[pred_pos & ~is_gold].copy()
    fn = df[~pred_pos & is_gold].copy()

    def count_tags(sub: pd.DataFrame):
        c = {}
        for tags in sub["Tags"].apply(split_tags):
            for t in tags:
                c[t] = c.get(t, 0) + 1
        return pd.Series(c).sort_values(ascending=False)

    return count_tags(fp), count_tags(fn)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="Export CSV from Omigator")
    ap.add_argument("--gold", required=True, help="Goldstandard file containing GSE IDs")
    ap.add_argument("--thresholds", default="60,70,80", help="Score thresholds to evaluate (comma-separated)")
    ap.add_argument("--k", default="20,50,100", help="K values for Recall@K/Precision@K")
    args = ap.parse_args()

    gold = read_gold(args.gold)

    df = pd.read_csv(args.csv)
    df["GSE_ID"] = df["GSE_ID"].apply(norm_gse)
    df = df[df["GSE_ID"] != ""].drop_duplicates("GSE_ID")

    df["Score"] = pd.to_numeric(df["Score"], errors="coerce").fillna(0).astype(float)
    df["Decision"] = df["Decision"].fillna("").astype(str)
    df["Tags"] = df["Tags"].fillna("").astype(str)

    print(f"Rows (unique GSE): {len(df)}")
    print(f"Gold positives:     {len(gold)}\n")

    # Decision-based evaluation
    m_dec = confusion(df, gold, (df["Decision"].str.lower() == "include"))
    print("=== Decision-based (Decision == include) ===")
    print(m_dec, "\n")

    # Score-based evaluation
    print("=== Score-threshold evaluation ===")
    for t in [int(x) for x in args.thresholds.split(",") if x.strip()]:
        m = confusion(df, gold, (df["Score"] >= t))
        print(f"t={t}: precision={m['precision']:.3f} recall={m['recall']:.3f} f1={m['f1']:.3f} "
              f"(tp={m['tp']} fp={m['fp']} fn={m['fn']} tn={m['tn']})")
    print()

    # Ranking metrics
    df_sorted = df.sort_values("Score", ascending=False).reset_index(drop=True)
    print("=== Ranking metrics ===")
    for k in [int(x) for x in args.k.split(",") if x.strip()]:
        print(f"Recall@{k}={recall_at_k(df_sorted, gold, k):.3f}  Precision@{k}={precision_at_k(df_sorted, gold, k):.3f}")
    print()

    # Tag-based error analysis
    fp_tags, fn_tags = tag_enrichment(df, gold, (df["Decision"].str.lower() == "include"))
    print("=== Top FP tags (Decision-based) ===")
    if len(fp_tags) > 0:
        print(fp_tags.head(20).to_string(), "\n")
    else:
        print("(none)\n")

    print("=== Top FN tags (Decision-based) ===")
    if len(fn_tags) > 0:
        print(fn_tags.head(20).to_string(), "\n")
    else:
        print("(none)\n")

    # Helpful lists
    fp_list = df[(df["Decision"].str.lower()=="include") & (~df["GSE_ID"].isin(gold))][["GSE_ID","Score","Title","Tags"]]
    fn_list = df[(df["Decision"].str.lower()!="include") & (df["GSE_ID"].isin(gold))][["GSE_ID","Score","Title","Tags"]]
    fp_list.to_csv("fp_list.csv", index=False)
    fn_list.to_csv("fn_list.csv", index=False)
    print("[WROTE] fp_list.csv, fn_list.csv")

if __name__ == "__main__":
    main()
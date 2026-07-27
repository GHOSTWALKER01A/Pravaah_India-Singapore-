"""Offline training — run once, ship the artefacts.

    python -m app.train                     # train + calibrate + fairness back-test
    python -m app.train --version 1.1.0     # a candidate version

Writes ``models/model.joblib`` and ``models/feature_schema.joblib``, then prints a
registration payload for ``POST /api/v1/admin/score/models``.

## About the training data

There is no public dataset of Indian Account Aggregator features with repayment
outcomes, so this generates a synthetic population from an explicit, readable
data-generating process. That is stated plainly rather than dressed up: the model
is only as good as the assumptions below, and they are in one place so a reviewer
can argue with them.

Two properties are engineered in deliberately, because they are what the fairness
audit and the anti-gaming design exist to handle:

1. **Protected attributes are correlated with the FEATURES but never used as
   inputs.** Younger subjects genuinely have shorter histories. A model that only
   sees `months_covered` can therefore still produce an age disparity — which is
   the whole point: dropping the attribute does not make the bias go away, so you
   have to measure the outcome. This is what makes the audit find something real
   instead of confirming a tautology.
2. **Outcome depends on trend features, not balances.** A subject who parks a lump
   sum has a high `avg_balance` and a low `balance_retention`, and repays badly.
   A model trained on this cannot be gamed by parking money.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, List, Tuple

import joblib
import numpy as np

# Windows consoles default to a legacy code page (cp1252), which raises
# UnicodeEncodeError on the glyphs this report prints. Reconfiguring the streams
# is the fix rather than stripping the glyphs: it covers every future line too,
# and the worst case on a console that cannot render them is mojibake instead of
# a crash that throws away a completed training run.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):  # non-tty, or already-wrapped stream
        pass

from .fairness import group_metrics, monitored_concerns, verdict
from .schema import (
    BANDS,
    FEATURES,
    PROTECTED_ATTRIBUTES,
    TARGET_P10_SCORE,
    TARGET_P90_SCORE,
    fit_score_calibration,
    probability_to_score,
)

RNG_SEED = 20260718
N_ROWS = 50_000
MODEL_DIR = "models"

# Population mix. Not uniform, because a uniform population would hide exactly
# the small-group problems the fairness gate is meant to catch.
GENDERS = [("female", 0.46), ("male", 0.50), ("other", 0.02), ("prefer_not_to_say", 0.02)]
AGE_BANDS = [("18-25", 0.22), ("26-35", 0.34), ("36-45", 0.24), ("46-60", 0.15), ("60+", 0.05)]
NATIONALITIES = [("IN", 0.88), ("SG", 0.08), ("AE", 0.03), ("US", 0.01)]


def _pick(rng: np.random.Generator, choices: List[Tuple[str, float]], n: int):
    values = [c[0] for c in choices]
    weights = np.array([c[1] for c in choices], dtype=float)
    return rng.choice(values, size=n, p=weights / weights.sum())


def generate_population(n: int = N_ROWS, seed: int = RNG_SEED):
    """Synthesise features, protected attributes, and repayment outcomes."""
    rng = np.random.default_rng(seed)

    gender = _pick(rng, GENDERS, n)
    age_band = _pick(rng, AGE_BANDS, n)
    nationality = _pick(rng, NATIONALITIES, n)

    # ── age drives history depth and balance, as it does in reality ──────────
    age_index = np.select(
        [age_band == "18-25", age_band == "26-35", age_band == "36-45", age_band == "46-60"],
        [0.0, 1.0, 2.0, 3.0],
        default=4.0,
    )
    months_covered = np.clip(
        rng.normal(6 + 3.4 * age_index, 4.0, n).round(), 1, 24
    )

    # Earnings rise with age band, with a wide spread. The FEATURE is the monthly
    # rate, not the window total: summing over a variable-length data range makes
    # income incomparable between subjects and double-counts `months_covered`,
    # which shows up downstream as an age disparity in the fairness audit.
    monthly_inflow = np.clip(
        rng.lognormal(mean=np.log(35_000) + 0.16 * age_index, sigma=0.55, size=n),
        6_000,
        900_000,
    )
    monthly_income = monthly_inflow

    # Regularity: salaried subjects are steady, the self-employed are not. Modelled
    # as a mixture so the feature has genuine bimodality rather than one blob.
    salaried = rng.random(n) < 0.62
    income_regularity = np.where(
        salaried,
        np.clip(rng.normal(0.88, 0.08, n), 0.25, 0.995),
        np.clip(rng.normal(0.55, 0.16, n), 0.15, 0.98),
    )

    obligation_ratio = np.clip(rng.normal(0.72, 0.22, n), 0.05, 1.8)

    # ── the park-and-withdraw cohort ────────────────────────────────────────
    # 12% of subjects inflate their balance for the data window and pull it back
    # out. They look rich on `avg_balance` and are exposed by `balance_retention`.
    gamers = rng.random(n) < 0.12
    base_balance = np.clip(
        monthly_income * rng.normal(1.9, 0.9, n) * (1 + 0.25 * age_index),
        500,
        6_000_000,
    )
    avg_balance = np.where(base_balance > 0, base_balance, 500)
    avg_balance = np.where(gamers, avg_balance * rng.uniform(2.2, 4.5, n), avg_balance)
    balance_retention = np.where(
        gamers,
        np.clip(rng.normal(0.14, 0.08, n), 0.0, 0.45),
        np.clip(rng.normal(0.72, 0.18, n), 0.0, 1.0),
    )

    bounce_count = rng.poisson(
        np.clip(0.9 + 2.4 * (obligation_ratio - 0.7), 0.05, 5.0), n
    ).astype(float)

    # ── GST: present for ~28% of subjects (business files) ───────────────────
    has_gst = rng.random(n) < 0.28
    gst_turnover = np.where(
        has_gst,
        np.clip(rng.lognormal(np.log(4_000_000), 0.85, n), 100_000, 90_000_000),
        np.nan,
    )
    gst_filing_consistency = np.where(
        has_gst, np.clip(rng.normal(0.86, 0.16, n), 0.0, 1.0), np.nan
    )

    # ── outcome: P(repays well) ─────────────────────────────────────────────
    # Weighted toward trend and behaviour, NOT toward how much money is sitting
    # in the account on the day we looked.
    logit = (
        -1.05
        + 2.30 * (income_regularity - 0.7)
        + 1.85 * (balance_retention - 0.55)
        - 2.05 * (obligation_ratio - 0.72)
        + 0.055 * (months_covered - 8)
        - 0.30 * bounce_count
        + 0.55 * (np.log1p(monthly_inflow / 20_000) - np.log1p(2.25))
        # Balance earns a genuine but small coefficient: a buffer helps, and it is
        # nowhere near enough on its own to carry a score.
        + 0.22 * (np.log1p(avg_balance / 25_000) - np.log1p(1.8))
        + np.where(has_gst, 0.30 * (np.nan_to_num(gst_filing_consistency) - 0.5), 0.0)
        + rng.normal(0, 0.45, n)
    )
    p_good = 1 / (1 + np.exp(-logit))
    y = (rng.random(n) < p_good).astype(int)

    X = np.column_stack(
        [
            monthly_inflow,
            income_regularity,
            avg_balance,
            balance_retention,
            obligation_ratio,
            months_covered,
            bounce_count,
            gst_turnover,
            gst_filing_consistency,
        ]
    )
    protected = {
        "gender": gender,
        "age_band": age_band,
        "nationality": nationality,
    }
    return X, y, protected


def build_estimator():
    """XGBoost if available, otherwise sklearn's gradient booster.

    Both are tree ensembles, so ``shap.TreeExplainer`` gives exact contributions
    either way. The fallback exists because XGBoost wheels lag new Python releases,
    and a hard import failure there would make the whole service unbuildable for a
    reason that has nothing to do with the model.
    """
    try:
        from xgboost import XGBClassifier

        return (
            XGBClassifier(
                n_estimators=400,
                max_depth=4,
                learning_rate=0.06,
                subsample=0.85,
                colsample_bytree=0.85,
                reg_lambda=1.5,
                min_child_weight=8,
                # Shallow trees + monotone-ish shrinkage keep the model close to
                # additive, which keeps its SHAP explanations legible to a human.
                eval_metric="logloss",
                random_state=RNG_SEED,
                # NaN is meaningful here (no GST file), so it is passed through
                # rather than imputed at training time.
                missing=np.nan,
            ),
            "xgboost",
        )
    except ImportError:
        from sklearn.ensemble import HistGradientBoostingClassifier

        print("  ⚠ xgboost unavailable — using sklearn HistGradientBoosting")
        return (
            HistGradientBoostingClassifier(
                max_iter=400,
                max_depth=4,
                learning_rate=0.06,
                l2_regularization=1.5,
                min_samples_leaf=20,
                random_state=RNG_SEED,
            ),
            "sklearn-hgb",
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the M2 reputation model.")
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--rows", type=int, default=N_ROWS)
    parser.add_argument("--seed", type=int, default=RNG_SEED)
    parser.add_argument("--out", default=MODEL_DIR)
    args = parser.parse_args()

    from sklearn.calibration import CalibratedClassifierCV
    from sklearn.metrics import brier_score_loss, roc_auc_score
    from sklearn.model_selection import train_test_split

    print(f"▶ Generating {args.rows:,} synthetic subjects (seed={args.seed})")
    X, y, protected = generate_population(args.rows, args.seed)

    idx = np.arange(len(y))
    train_idx, test_idx = train_test_split(
        idx, test_size=0.25, random_state=args.seed, stratify=y
    )

    estimator, flavour = build_estimator()
    print(f"▶ Fitting {flavour}")
    estimator.fit(X[train_idx], y[train_idx])

    # Calibration matters more than AUC here. Ranking correctly is not enough when
    # the probability is multiplied by 600 and shown to someone as their score:
    # an uncalibrated 0.8 that should be 0.65 is ninety points of lie.
    print("▶ Calibrating (isotonic, 5-fold)")
    calibrator = CalibratedClassifierCV(estimator, method="isotonic", cv=5)
    calibrator.fit(X[train_idx], y[train_idx])

    raw_p = estimator.predict_proba(X[test_idx])[:, 1]
    cal_p = calibrator.predict_proba(X[test_idx])[:, 1]
    auc = roc_auc_score(y[test_idx], cal_p)
    print(f"  AUC              {auc:.4f}")
    print(f"  Brier (raw)      {brier_score_loss(y[test_idx], raw_p):.4f}")
    print(f"  Brier (calib.)   {brier_score_loss(y[test_idx], cal_p):.4f}  ← lower is better")

    # Spread the population across the 300..900 scale.
    #
    # Fitted on the TRAINING split, then applied to held-out scores — fitting it on
    # the same rows we then report the distribution of would flatter it.
    print(
        f"▶ Fitting the score scale (target p10={TARGET_P10_SCORE}, p90={TARGET_P90_SCORE})"
    )
    train_p = calibrator.predict_proba(X[train_idx])[:, 1]
    score_calibration = fit_score_calibration(train_p)
    print(
        f"  log-odds map      z' = {score_calibration['a']:.4f}·z "
        f"{'+' if score_calibration['b'] >= 0 else '-'} {abs(score_calibration['b']):.4f}"
    )

    scores = np.array([probability_to_score(p, score_calibration) for p in cal_p])
    print(
        f"  Score p10/50/90  {np.percentile(scores, 10):.0f} / "
        f"{np.percentile(scores, 50):.0f} / {np.percentile(scores, 90):.0f}"
    )
    for lo, hi, name in BANDS:
        share = ((scores >= lo) & (scores <= hi)).mean()
        print(f"    {name:<10} {share * 100:5.1f}%")

    # ── fairness back-test on the held-out set ──────────────────────────────
    print("▶ Fairness back-test (held-out)")
    approved = (scores >= 670).astype(int)
    approved_by_group: Dict[str, List[int]] = {}
    tpr_by_group: Dict[str, List[int]] = {}
    for i, row in enumerate(test_idx):
        for attribute in PROTECTED_ATTRIBUTES:
            key = f"{attribute}:{protected[attribute][row]}"
            approved_by_group.setdefault(key, []).append(int(approved[i]))
            if y[row] == 1:
                tpr_by_group.setdefault(key, []).append(int(approved[i]))

    reports = group_metrics(
        approved_by_group, float(approved.mean()), tpr_by_group
    )
    passed = verdict(reports)
    for r in sorted(reports, key=lambda r: (r["metric"], r["group"])):
        flag = "ok  " if r["passed"] else "FAIL"
        print(
            f"    [{flag}] {r['metric']:<20} {r['group']:<28} "
            f"{r['value']:>6.3f} (n={r['sample_size']})"
        )
    print(f"  Verdict: {'PASSED' if passed else 'FAILED'}")
    if not passed:
        print(
            "  ⚠ This version would be BLOCKED from activation. That is the gate "
            "working — see the mitigation options in the admin fairness report."
        )

    # ── artefacts ───────────────────────────────────────────────────────────
    os.makedirs(args.out, exist_ok=True)
    model_path = os.path.join(args.out, "model.joblib")
    schema_path = os.path.join(args.out, "feature_schema.joblib")

    joblib.dump(
        {
            "model": estimator,
            "calibrator": calibrator,
            "version": args.version,
            # Part of the artefact, not a serving-time constant: the map is fitted
            # to THIS model's probability distribution, so shipping it alongside the
            # estimator is what makes a score reproducible.
            "score_calibration": score_calibration,
            "metadata": {
                "flavour": flavour,
                "rows": int(args.rows),
                "seed": int(args.seed),
                "auc": round(float(auc), 4),
                "brier": round(float(brier_score_loss(y[test_idx], cal_p)), 4),
                "score_p10": int(np.percentile(scores, 10)),
                "score_median": int(np.percentile(scores, 50)),
                "score_p90": int(np.percentile(scores, 90)),
                "fairness_backtest_passed": bool(passed),
                "fairness_backtest_monitored": len(monitored_concerns(reports)),
            },
        },
        model_path,
    )
    joblib.dump({"features": FEATURES}, schema_path)
    print(f"▶ Wrote {model_path} and {schema_path}")

    # The registration payload, so the artefact and the registry entry can never
    # drift apart by hand-typing.
    payload = {
        "name": "pravaah-credit",
        "version": args.version,
        "runtime": "fastapi",
        "featureSchema": {
            "features": [
                {
                    "name": f,
                    "dtype": "int" if f in ("months_covered", "bounce_count") else "float",
                    "optional": f in ("gst_turnover", "gst_filing_consistency"),
                }
                for f in FEATURES
            ]
        },
        "bands": [{"min": lo, "max": hi, "band": b} for lo, hi, b in BANDS],
        "trainedAt": "2026-07-25T00:00:00+05:30",
        "datasetRef": f"synthetic-{flavour}-{args.rows}r-seed{args.seed}",
        "notes": f"{flavour}, isotonic-calibrated. AUC {auc:.4f}.",
    }
    print("\n▶ Register with POST /api/v1/admin/score/models:\n")
    print(json.dumps(payload, indent=2))
    print(
        "\n  Then run the fairness audit before activating — registration alone "
        "does not make a version servable."
    )


if __name__ == "__main__":
    main()

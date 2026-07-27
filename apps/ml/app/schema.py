"""Feature contract shared by training and serving.

The ORDER of ``FEATURES`` is the contract with NestJS's ``FeatureAssemblerService``
and with every score ever issued: a score is only reproducible from its
``inputsHash`` if the vector was built in this order. Changing this list is a new
model version, never an edit to an existing one.

Mirrors ``SCORE_FEATURES`` in ``packages/pravaah-schema/src/scoring``.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Sequence, Tuple

FEATURES: List[str] = [
    "monthly_inflow",
    "income_regularity",
    "avg_balance",
    "balance_retention",
    "obligation_ratio",
    "months_covered",
    "bounce_count",
    "gst_turnover",
    "gst_filing_consistency",
]

# NO protected attributes appear here, by construction. gender / age band /
# nationality are collected under a separate consent, stored encrypted by the
# backend, and used ONLY by /fairness to test outcomes across groups.
PROTECTED_ATTRIBUTES: List[str] = ["gender", "age_band", "nationality"]

# Features supplied only by a business (GST) file. Their absence is
# NOT-APPLICABLE, not missing: a salaried subject has no GST filings to share, and
# widening their confidence band for not running a business would penalise the
# wrong thing. We cannot tell "has no GSTIN" from "has one and didn't share it"
# from the features alone, so not-applicable is the only honest reading.
OPTIONAL_FEATURES: set[str] = {"gst_turnover", "gst_filing_consistency"}

# Score scale and band cutoffs. The backend stores these per model version too
# (they travel with the M3 credential); these are the training-time defaults.
SCORE_MIN = 300
SCORE_MAX = 900
SCORE_SPAN = SCORE_MAX - SCORE_MIN

BANDS: List[Tuple[int, int, str]] = [
    (300, 579, "POOR"),
    (580, 669, "FAIR"),
    (670, 739, "GOOD"),
    (740, 799, "VERY_GOOD"),
    (800, 900, "EXCELLENT"),
]

# Population-typical value per feature. Used as the NEUTRAL IMPUTATION for a
# missing feature so that absent data moves the score by ~zero instead of
# scoring the subject as if they had none of it — the gap is charged to
# confidence instead. Kept in step with SCORECARD_V1.reference on the Nest side.
NEUTRAL: Dict[str, float] = {
    "monthly_inflow": 45_000.0,
    "income_regularity": 0.70,
    "avg_balance": 45_000.0,
    "balance_retention": 0.55,
    "obligation_ratio": 0.80,
    "months_covered": 8.0,
    "bounce_count": 0.3,
    # Most files have no GST at all: zero here means a salaried subject is
    # neither flattered nor penalised for not running a business.
    "gst_turnover": 0.0,
    "gst_filing_consistency": 0.0,
}


def band_for(score: int) -> str:
    for lo, hi, name in BANDS:
        if lo <= score <= hi:
            return name
    return "EXCELLENT" if score > SCORE_MAX else "POOR"


# Where the population should land on the 300..900 scale. `train.py` fits an affine
# map in LOG-ODDS space against these targets and stores it in the artefact.
#
# Mapping P(good) straight onto the scale (300 + 600p) does not work: it inherits
# the base rate. A synthetic population that is 26% "good" lands with a median of
# 516 and 69% in POOR, and a realistic 90%-good portfolio would pile everyone above
# 840 — in both cases the bands stop discriminating. Scorecards have always been
# built affine in log-odds for exactly this reason, and it is also what keeps this
# runtime's distribution comparable to the in-process scorecard's, so activating
# one over the other does not shift every user by 200 points.
TARGET_P10_SCORE = 600
TARGET_P90_SCORE = 780


def _logit(p: float) -> float:
    eps = 1e-9
    q = min(1.0 - eps, max(eps, float(p)))
    return math.log(q / (1.0 - q))


def _sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-z))


def target_logit_bounds() -> Tuple[float, float]:
    """The log-odds the fitted map must send p10 and p90 to."""
    return (
        _logit((TARGET_P10_SCORE - SCORE_MIN) / SCORE_SPAN),
        _logit((TARGET_P90_SCORE - SCORE_MIN) / SCORE_SPAN),
    )


def fit_score_calibration(probabilities: Sequence[float]) -> Dict[str, float]:
    """Fit `z' = a·z + b` so the population's p10/p90 hit the target scores.

    Two-point fit on the decile bounds rather than a mean/sd fit: it is robust to
    the tails, and the deciles are what the band cutoffs actually need to separate.
    """
    logits = sorted(_logit(p) for p in probabilities)
    if len(logits) < 20:
        return {"a": 1.0, "b": 0.0}
    lo = logits[int(0.10 * (len(logits) - 1))]
    hi = logits[int(0.90 * (len(logits) - 1))]
    t_lo, t_hi = target_logit_bounds()
    if hi - lo < 1e-6:
        return {"a": 1.0, "b": t_lo - lo}
    a = (t_hi - t_lo) / (hi - lo)
    return {"a": a, "b": t_lo - a * lo}


def probability_to_score(
    p: float,
    calibration: Optional[Dict[str, float]] = None,
) -> int:
    """Monotonic map P(good) -> 300..900.

    With `calibration`, applies the fitted affine transform in log-odds space
    first. Without it, falls back to the raw linear map — correct only for an
    already-well-spread probability, and used just for the untrained case.
    """
    if calibration:
        z = calibration.get("a", 1.0) * _logit(p) + calibration.get("b", 0.0)
        return int(round(SCORE_MIN + SCORE_SPAN * _sigmoid(z)))
    clamped = max(0.0, min(1.0, float(p)))
    return int(round(SCORE_MIN + SCORE_SPAN * clamped))


def to_vector(
    features: Dict[str, Optional[float]],
    order: Optional[List[str]] = None,
) -> Tuple[List[float], int, int]:
    """Build the ordered vector.

    Returns ``(vector, missing_required, required_count)``. Only REQUIRED features
    count as missing — see ``OPTIONAL_FEATURES``. The count is returned rather
    than swallowed because it is what pulls the confidence band wider: an imputed
    vector must never look as certain as a complete one.
    """
    names = order or FEATURES
    vector: List[float] = []
    missing_required = 0
    required_count = 0

    for name in names:
        optional = name in OPTIONAL_FEATURES
        if not optional:
            required_count += 1

        raw = features.get(name)
        imputed = False
        if raw is None:
            imputed = True
            value = NEUTRAL.get(name, 0.0)
        else:
            try:
                value = float(raw)
            except (TypeError, ValueError):
                imputed = True
                value = NEUTRAL.get(name, 0.0)
            else:
                # NaN / inf reach here from upstream JSON or a bad computation.
                if value != value or value in (float("inf"), float("-inf")):
                    imputed = True
                    value = NEUTRAL.get(name, 0.0)

        if imputed and not optional:
            missing_required += 1
        vector.append(value)

    return vector, missing_required, required_count


def unknown_feature_keys(
    features: Dict[str, Optional[float]],
    order: Optional[List[str]] = None,
) -> List[str]:
    """Keys the caller sent that this model does not consume.

    Reported as an ERROR rather than ignored. A stale key is the exact shape of a
    dangerous bug: renaming `total_inflow` to `monthly_inflow` and leaving one
    caller behind produced a silently different score (813 vs 807) with no signal
    at all, because the unknown key was dropped and the real feature was imputed.
    NestJS builds the vector from the registered feature schema and should never
    send an unknown key, so if one arrives the two sides are out of sync and the
    honest response is a refusal.
    """
    known = set(order or FEATURES)
    return sorted(k for k in features if k not in known)


def to_matrix(
    rows: Sequence[Dict[str, Optional[float]]],
    order: Optional[List[str]] = None,
) -> Tuple[List[List[float]], List[int], int]:
    """Vectorise many rows at once.

    Batching is not a micro-optimisation here: scoring one row at a time costs
    ~25 ms of per-call overhead, so a 2000-subject fairness audit took 46 s. One
    matrix through the same estimator takes 35 ms — a ~660x difference, and the
    difference between an audit an admin will actually run before every activation
    and one they will route around.
    """
    vectors: List[List[float]] = []
    missing: List[int] = []
    required = 0
    for row in rows:
        vec, miss, req = to_vector(row, order)
        vectors.append(vec)
        missing.append(miss)
        required = req
    return vectors, missing, required


def compute_confidence(
    coverage: float,
    probability: float,
    missing_required: int,
    required_count: int,
) -> Dict[str, float]:
    """confidence = data coverage x model certainty x feature completeness.

    All three components are returned, not just the product, so a low confidence
    is explainable: the admin console can say WHICH term dragged it down instead
    of showing an unaccountable 0.31. Must stay numerically identical to
    ``computeConfidence`` in ``scoring.state.ts``.
    """
    cov = max(0.0, min(1.0, float(coverage)))
    model_certainty = abs(float(probability) - 0.5) * 2
    # Bounded to [0.5, 1] so a borderline call widens the band without ever
    # collapsing confidence to zero on its own.
    certainty = 0.5 + 0.5 * model_certainty
    completeness = (
        max(0.0, 1 - (missing_required / required_count))
        if required_count > 0
        else 0.0
    )
    return {
        "confidence": round(cov * certainty * completeness, 3),
        "coverage": round(cov, 3),
        "certainty": round(certainty, 3),
        "completeness": round(completeness, 3),
    }

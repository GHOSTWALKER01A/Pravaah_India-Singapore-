"""pravaah-inference — M2's model service.

Owns the model, the SHAP math, and the fairness computation. NestJS owns
orchestration, caching, versioning, persistence and serving, and reaches this
service over the internal network only: it is never exposed to a client, because
a client that can call /predict directly can shop for a score.

Isolated in its own process on purpose — a model crash or an OOM in shap must not
be able to take down authentication or payments (M2 §1.6). The Nest side wraps
every call in a circuit breaker and falls back to the last cached score.

Run:  uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .fairness import (
    BLOCKING_ATTRIBUTES,
    MIN_GROUP_SIZE,
    THRESHOLDS,
    group_metrics,
    monitored_concerns,
    verdict,
)
from .model import ModelNotLoaded, load_model
from .schema import (
    FEATURES,
    band_for,
    compute_confidence,
    probability_to_score,
    to_matrix,
    to_vector,
    unknown_feature_keys,
)

log = logging.getLogger("pravaah.inference")

# Hard ceiling on one audit request. Unbounded `rows` is an OOM waiting to happen,
# and 5000 subjects is already far more than any group needs to be decisive.
MAX_AUDIT_ROWS = 5000


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Load the artefact and build the explainer BEFORE serving traffic.

    Without this the first request pays the `shap` import and TreeExplainer
    construction — several seconds. NestJS times a predict out at 8 s and opens its
    circuit breaker after five failures, so a cold start could trip the breaker and
    take the runtime offline for 30 s over nothing. Warming up here turns that into
    a slower boot, which is the right place for the cost.
    """
    try:
        model = load_model()
        # One throwaway evaluation so the explainer's lazy internals are built too.
        warm = [0.0] * len(model.features)
        model.explain(warm)
        log.info("model %s warm (%d features)", model.version, len(model.features))
    except ModelNotLoaded as exc:
        log.warning("starting with NO model artefact: %s", exc)
    except Exception:  # pragma: no cover - corrupt artefact
        log.exception("model failed to warm up; /health will report the reason")
    yield


app = FastAPI(
    title="pravaah-inference",
    version="1.0.0",
    description=(
        "M2 Reputation Engine inference: XGBoost scoring + exact TreeSHAP "
        "explanations + group-fairness auditing. Internal network only."
    ),
    lifespan=lifespan,
)


# ── wire contracts ──────────────────────────────────────────────────────────
# snake_case throughout: this is the Python-side contract, and NestJS's
# FastApiInferenceProvider translates at the boundary rather than leaking
# camelCase into the model service.
class PredictIn(BaseModel):
    features: Dict[str, Optional[float]] = Field(
        ..., description="Keyed by feature name. None means the data was absent."
    )
    coverage: float = Field(0.0, ge=0.0, le=1.0, description="M1 data coverage.")
    # min_length=1: an empty string used to slip past the version guard entirely,
    # which is the one check that keeps a score reproducible.
    model_version: str = Field(..., min_length=1)


class FactorOut(BaseModel):
    feature: str
    shap_value: float
    direction: str


class PredictOut(BaseModel):
    score: int
    band: str
    # Isotonic-calibrated P(good). This is what the score is computed from.
    probability: float
    confidence: float
    coverage: float
    certainty: float
    completeness: float
    factors: List[FactorOut]
    base_value: float
    # The base estimator's margin, which the SHAP values explain EXACTLY:
    # raw_margin == base_value + sum(shap_value). Returned so the additivity axiom
    # is checkable rather than merely claimed. Note it is the pre-calibration
    # quantity — see LoadedModel.shap_values for why that is the honest thing to
    # attribute, and what it does and does not let you conclude.
    raw_margin: float
    missing_count: int
    model_version: str


class CounterfactualIn(PredictIn):
    feature: str
    target_value: float


class CounterfactualOut(BaseModel):
    score: int
    band: str
    probability: float
    feature: str
    target_value: float


class ScoreBatchIn(BaseModel):
    """Score many feature vectors in one call.

    Exists so a fairness audit is one round trip instead of N. NestJS owns the
    fairness MATHS (one implementation, shared by both runtimes) and only needs the
    scores; making it fetch them one HTTP call at a time turned a 2000-subject audit
    into minutes of round trips.
    """

    rows: List[Dict[str, Optional[float]]] = Field(..., max_length=MAX_AUDIT_ROWS)
    model_version: str = Field(..., min_length=1)


class ScoreBatchOut(BaseModel):
    scores: List[int]
    bands: List[str]
    probabilities: List[float]
    missing_counts: List[int]
    model_version: str


class FairnessRow(BaseModel):
    features: Dict[str, Optional[float]]
    # Audit-only. These are NEVER read into the feature vector — the only code
    # path that touches them is the group bucketing below.
    protected: Dict[str, Optional[str]] = Field(default_factory=dict)
    y_true: Optional[int] = Field(
        None, description="Ground-truth good/bad, when known. Enables equal opportunity."
    )


class FairnessIn(BaseModel):
    rows: List[FairnessRow] = Field(..., max_length=MAX_AUDIT_ROWS)
    positive_band_min: int = Field(670, ge=300, le=900)
    # No per-row `coverage`: an audit only needs approve/reject, and confidence
    # plays no part in it. The field used to be accepted and silently ignored,
    # which is worse than not having it.


# ── helpers ─────────────────────────────────────────────────────────────────
def _require_model():
    try:
        return load_model()
    except ModelNotLoaded as exc:
        # 503, not 500: the service is healthy, it simply has no artefact yet.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - artefact corruption
        raise HTTPException(
            status_code=503, detail=f"Model failed to load: {exc}"
        ) from exc


def _check_version(requested: str, loaded: str) -> None:
    """Refuse to answer as a version we are not.

    A 409 here is the right failure: NestJS stamps the requested version on the
    Score row, so quietly answering with a different model would make every
    affected score unreproducible and the audit trail a lie. The Nest side keeps
    the prior score and does not trip its circuit breaker on this.
    """
    if requested and loaded and requested != loaded:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Model version mismatch: this service serves {loaded}, "
                f"but {requested} was requested."
            ),
        )


def _reject_unknown(model, features: Dict[str, Optional[float]], where: str) -> None:
    """Refuse a request carrying a feature this model does not consume.

    Not pedantry — a silently-dropped key produces a silently WRONG score. Renaming
    `total_inflow` to `monthly_inflow` and leaving one caller stale returned 807
    instead of 813 with `missing_count: 1` and no other signal. NestJS assembles the
    vector from the registered feature schema, so an unknown key means the two sides
    are out of sync, and answering anyway would put an unreproducible number on
    someone's credit file.
    """
    unknown = unknown_feature_keys(features, model.features)
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown feature key(s) in {where}: {unknown}. "
                f"This model consumes exactly: {model.features}. "
                "Dropping them would silently change the score."
            ),
        )


def _score_vector(model, features: Dict[str, Optional[float]]):
    vector, missing_required, required_count = to_vector(features, model.features)
    probability = model.predict_proba(vector)
    # The fitted log-odds calibration is what keeps this runtime's score
    # distribution comparable to the in-process scorecard's.
    score = probability_to_score(probability, model.score_calibration)
    return vector, missing_required, required_count, probability, score


def _score_rows(model, rows: List[Dict[str, Optional[float]]]):
    """Score many rows through ONE estimator call. ~660x faster than looping."""
    vectors, missing, _ = to_matrix(rows, model.features)
    probabilities = model.predict_proba_batch(vectors)
    scores = [
        probability_to_score(p, model.score_calibration) for p in probabilities
    ]
    return scores, probabilities, missing


# ── routes ──────────────────────────────────────────────────────────────────
@app.get("/health")
def health() -> Dict[str, object]:
    """Liveness + artefact readiness, separately.

    Deliberately does not 503 when the model is missing: the container is up, and
    an orchestrator restarting it would not conjure an artefact. `model_loaded`
    tells the operator which problem they actually have.
    """
    try:
        model = load_model()
        return {
            "status": "ok",
            "model_loaded": True,
            "model_version": model.version,
            "features": model.features,
            "score_calibration": model.score_calibration,
            "metadata": model.metadata,
        }
    except ModelNotLoaded as exc:
        return {
            "status": "ok",
            "model_loaded": False,
            "reason": str(exc),
            "expected_features": FEATURES,
        }
    except Exception as exc:  # pragma: no cover - corrupt artefact
        # A corrupt artefact must not make /health itself 500. The docstring above
        # promises this endpoint always answers; catching only ModelNotLoaded broke
        # that promise for exactly the case an operator most needs to see.
        log.exception("health: model failed to load")
        return {
            "status": "ok",
            "model_loaded": False,
            "reason": f"Model failed to load: {exc}",
            "expected_features": FEATURES,
        }


@app.post("/predict", response_model=PredictOut)
def predict(payload: PredictIn) -> PredictOut:
    model = _require_model()
    _check_version(payload.model_version, model.version)
    _reject_unknown(model, payload.features, "features")

    vector, missing_required, required_count, probability, score = _score_vector(
        model, payload.features
    )
    contribs, base, margin = model.explain(vector)

    conf = compute_confidence(
        coverage=payload.coverage,
        probability=probability,
        missing_required=missing_required,
        required_count=required_count,
    )

    factors = [
        FactorOut(
            feature=name,
            shap_value=round(value, 6),
            direction="POSITIVE" if value >= 0 else "NEGATIVE",
        )
        for name, value in zip(model.features, contribs)
    ]
    # Biggest driver first; ties broken by the fitted feature order so repeated
    # identical requests produce an identical "why" panel.
    factors.sort(key=lambda f: (-abs(f.shap_value), model.features.index(f.feature)))

    return PredictOut(
        score=score,
        band=band_for(score),
        probability=round(probability, 6),
        confidence=conf["confidence"],
        coverage=conf["coverage"],
        certainty=conf["certainty"],
        completeness=conf["completeness"],
        factors=factors,
        base_value=round(base, 6),
        raw_margin=round(margin, 6),
        # Required-missing only, so the Nest side can reconstruct completeness.
        missing_count=missing_required,
        model_version=model.version,
    )


@app.post("/score-batch", response_model=ScoreBatchOut)
def score_batch(payload: ScoreBatchIn) -> ScoreBatchOut:
    """Score many vectors in one call. No SHAP — this is the audit path.

    NestJS owns the fairness maths so there is exactly one implementation of the
    four-fifths rule; it only needs the scores. Fetching them one HTTP call per
    subject made a 2000-row audit take minutes, which is how a pre-activation gate
    stops being run at all.
    """
    model = _require_model()
    _check_version(payload.model_version, model.version)
    if not payload.rows:
        return ScoreBatchOut(
            scores=[], bands=[], probabilities=[], missing_counts=[],
            model_version=model.version,
        )
    for i, row in enumerate(payload.rows):
        _reject_unknown(model, row, f"rows[{i}]")

    scores, probabilities, missing = _score_rows(model, payload.rows)
    return ScoreBatchOut(
        scores=scores,
        bands=[band_for(s) for s in scores],
        probabilities=[round(p, 6) for p in probabilities],
        missing_counts=missing,
        model_version=model.version,
    )


@app.post("/counterfactual", response_model=CounterfactualOut)
def counterfactual(payload: CounterfactualIn) -> CounterfactualOut:
    """Score under a single-feature intervention.

    This is how "raising your average balance would add ~30 points" gets its
    number: the model is re-run with one feature moved and everything else held.
    Deriving points from a SHAP value instead would be a fabrication — SHAP lives
    in margin space and the score is a non-linear squash of it.
    """
    model = _require_model()
    _check_version(payload.model_version, model.version)
    _reject_unknown(model, payload.features, "features")

    if payload.feature not in model.features:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown feature '{payload.feature}'. Known: {model.features}",
        )

    intervened = dict(payload.features)
    intervened[payload.feature] = payload.target_value
    _, _, _, probability, score = _score_vector(model, intervened)

    return CounterfactualOut(
        score=score,
        band=band_for(score),
        probability=round(probability, 6),
        feature=payload.feature,
        target_value=payload.target_value,
    )


@app.post("/fairness")
def fairness(payload: FairnessIn) -> Dict[str, object]:
    """Disparate impact (four-fifths rule), demographic parity, equal opportunity.

    Every row is re-scored under THIS service's loaded model rather than read from
    stored outputs, because auditing a candidate version against the outputs of
    the version currently in production would measure the wrong model.
    """
    model = _require_model()
    if not payload.rows:
        raise HTTPException(status_code=400, detail="No rows to audit.")
    for i, row in enumerate(payload.rows):
        _reject_unknown(model, row.features, f"rows[{i}].features")

    # ONE estimator call for the whole cohort. Looping cost ~25 ms per row, so a
    # 2000-subject audit took 46 s; batched it is ~35 ms.
    scores, _, _ = _score_rows(model, [r.features for r in payload.rows])

    approved_by_group: Dict[str, List[int]] = {}
    tpr_by_group: Dict[str, List[int]] = {}
    approved_total = 0

    for row, score in zip(payload.rows, scores):
        approved = 1 if score >= payload.positive_band_min else 0
        approved_total += approved

        for attribute, value in row.protected.items():
            if not value:
                continue
            key = f"{attribute}:{value}"
            approved_by_group.setdefault(key, []).append(approved)
            # Equal opportunity is only defined over subjects who were genuinely
            # good; rows without a label contribute nothing here.
            if row.y_true == 1:
                tpr_by_group.setdefault(key, []).append(approved)

    scored = len(scores)
    population_rate = approved_total / scored
    reports = group_metrics(
        approved_by_group,
        population_rate,
        tpr_by_group or None,
    )

    return {
        "passed": verdict(reports),
        "model_version": model.version,
        "subjects": scored,
        "group_count": len(approved_by_group),
        "population_approval_rate": round(population_rate, 3),
        "positive_band_min": payload.positive_band_min,
        "min_group_size": MIN_GROUP_SIZE,
        "blocking_attributes": sorted(BLOCKING_ATTRIBUTES),
        # Failures that do NOT block but must never be hidden.
        "monitored_concerns": monitored_concerns(reports),
        "thresholds": THRESHOLDS,
        "reports": reports,
    }


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        reload=False,
    )

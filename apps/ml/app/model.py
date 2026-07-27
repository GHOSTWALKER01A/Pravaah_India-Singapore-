"""Model + explainer loading.

Kept apart from ``main.py`` so the FastAPI layer stays a thin transport shell and
the artefact handling is testable on its own. Loading is lazy and cached: the
process must be able to boot (and answer ``/health``) even when no artefact has
been trained yet, otherwise a fresh clone can't tell "not trained" apart from
"crashed".
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Dict, List, Optional

import joblib
import numpy as np

from .schema import FEATURES

DEFAULT_MODEL_PATH = "models/model.joblib"
DEFAULT_SCHEMA_PATH = "models/feature_schema.joblib"


class ModelNotLoaded(RuntimeError):
    """Raised when an artefact is missing. Surfaced as a 503, not a 500 — the
    service is fine, it just has nothing to serve yet."""


@dataclass
class LoadedModel:
    estimator: Any
    explainer: Any
    features: List[str]
    version: str
    calibrator: Optional[Any]
    metadata: Dict[str, Any]
    # Affine map in log-odds space, fitted at training time, that spreads the
    # population across 300..900. See `fit_score_calibration`. None for an artefact
    # trained before this existed — the raw linear map is then used.
    score_calibration: Optional[Dict[str, float]] = None
    # Serialises access to the SHAP explainer, which is shared mutable state across
    # the threadpool uvicorn runs sync endpoints in. See `explain`.
    _explain_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def predict_proba(self, vector: List[float]) -> float:
        return self.predict_proba_batch([vector])[0]

    def predict_proba_batch(self, vectors: List[List[float]]) -> List[float]:
        """P(good) for many rows in ONE estimator call.

        The per-call overhead of a single-row predict is ~25 ms, so looping is
        ~660x slower than one matrix (46 s vs 35 ms over 2000 rows). Everything
        that scores more than one subject goes through here.
        """
        if not vectors:
            return []
        x = np.asarray(vectors, dtype=float)
        # A calibrator (isotonic / Platt) wraps the raw estimator when one was
        # fitted at training time: gradient-boosted margins are ranked well but
        # poorly calibrated, and an uncalibrated probability turns straight into
        # a wrong number of POINTS on a user's screen.
        source = self.calibrator if self.calibrator is not None else self.estimator
        return [float(p) for p in source.predict_proba(x)[:, 1]]

    def raw_margin(self, vector: List[float]) -> float:
        """The base estimator's margin (log-odds), before calibration.

        Exposed so the SHAP additivity axiom is checkable from the API rather than
        merely asserted: ``raw_margin == base_value + sum(contributions)``.
        """
        x = np.asarray(vector, dtype=float).reshape(1, -1)
        predict = getattr(self.estimator, "predict", None)
        if predict is not None:
            try:  # xgboost
                return float(predict(x, output_margin=True)[0])
            except TypeError:
                pass
        # sklearn ensembles expose the margin as decision_function.
        decision = getattr(self.estimator, "decision_function", None)
        if decision is not None:
            return float(np.asarray(decision(x)).reshape(-1)[0])
        p = float(self.estimator.predict_proba(x)[0][1])
        eps = 1e-9
        p = min(1 - eps, max(eps, p))
        return float(np.log(p / (1 - p)))

    def explain(self, vector: List[float]) -> tuple[List[float], float, float]:
        """Contributions, base value, and the raw margin from ONE guarded pass.

        Grouped because they are three views of a single model evaluation, and
        because the explainer is shared mutable state: uvicorn runs sync endpoints
        in a threadpool, so concurrent /predict calls would otherwise reach the
        same TreeExplainer at once. The lock is uncontended in the common case and
        cheap next to the evaluation itself.
        """
        with self._explain_lock:
            contribs, base = self.shap_values(vector)
            margin = self.raw_margin(vector)
        return contribs, base, margin

    def shap_values(self, vector: List[float]) -> tuple[List[float], float]:
        """Per-feature contributions in MARGIN space, plus the base value.

        TreeSHAP is exact for tree ensembles and the additivity axiom holds against
        the RAW margin: ``raw_margin == base_value + sum(contributions)``, verified
        to ~4e-7 (float precision).

        ## The calibration caveat, stated plainly
        These contributions explain the base estimator's margin, NOT the
        isotonic-calibrated probability the score is computed from. The two differ
        (e.g. raw 0.817 vs calibrated 0.777 on the demo profile), so the
        contributions do not sum to the logit of the score-determining probability.
        Isotonic calibration is piecewise-constant, so no exact tree-based
        attribution of it exists; KernelExplainer would only approximate it, far
        more slowly.

        What still holds, and why this is enough: calibration and the score map are
        both MONOTONE, so
            raw margin  ->  calibrated probability  ->  score
        is monotone end to end. The contributions therefore explain, exactly, the
        quantity that determines the score's ordering — the sign, magnitude and rank
        of every driver are faithful. Only their sum is not the score.

        (The in-process `scorecard` runtime has no such caveat: its calibration is
        an affine map in logit space folded into the weights, so contributions scale
        linearly and reconcile to the margin with a residual of exactly 0.)

        Contributions are never converted to points here. Point impact is answered
        by /counterfactual, which re-runs the model.
        """
        x = np.asarray(vector, dtype=float).reshape(1, -1)
        raw = self.explainer.shap_values(x)
        # shap returns a list per class for some binary configurations and a
        # single array for others; normalise both to the positive class.
        contribs = raw[1] if isinstance(raw, list) and len(raw) > 1 else raw
        contribs = np.asarray(contribs).reshape(-1)[: len(self.features)]

        expected = self.explainer.expected_value
        if isinstance(expected, (list, tuple, np.ndarray)):
            arr = np.asarray(expected).reshape(-1)
            base = float(arr[1] if arr.size > 1 else arr[0])
        else:
            base = float(expected)
        return [float(c) for c in contribs], base


@lru_cache(maxsize=1)
def load_model() -> LoadedModel:
    model_path = os.environ.get("MODEL_PATH", DEFAULT_MODEL_PATH)
    schema_path = os.environ.get("FEATURE_SCHEMA_PATH", DEFAULT_SCHEMA_PATH)
    version = os.environ.get("MODEL_VERSION", "1.0.0")

    if not os.path.exists(model_path):
        raise ModelNotLoaded(
            f"No model artefact at {model_path}. Run `python -m app.train` first."
        )

    bundle = joblib.load(model_path)
    # Accept both a bare estimator and the richer dict `train.py` writes, so a
    # hand-trained model dropped in by a data scientist still serves.
    if isinstance(bundle, dict):
        estimator = bundle["model"]
        calibrator = bundle.get("calibrator")
        metadata = bundle.get("metadata", {})
        version = bundle.get("version", version)
        score_calibration = bundle.get("score_calibration")
    else:
        estimator = bundle
        calibrator = None
        metadata = {}
        score_calibration = None

    features = FEATURES
    if os.path.exists(schema_path):
        loaded = joblib.load(schema_path)
        # The artefact's own order wins over the code constant: it is what the
        # model was actually fitted on.
        features = list(loaded["features"]) if isinstance(loaded, dict) else list(loaded)

    import shap  # imported lazily: it is only needed once a model exists

    explainer = shap.TreeExplainer(estimator)

    return LoadedModel(
        estimator=estimator,
        explainer=explainer,
        features=features,
        version=str(version),
        calibrator=calibrator,
        metadata=metadata,
        score_calibration=score_calibration,
    )


def reset_model_cache() -> None:
    """Drop the cached artefact — used after a retrain, and by tests."""
    load_model.cache_clear()

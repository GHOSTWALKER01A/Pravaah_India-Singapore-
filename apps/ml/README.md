# pravaah-inference · M2 model service

XGBoost + exact TreeSHAP + group-fairness math for the Reputation Engine.

## Is this service required?

**No — and that is a design decision, not a gap.** M2 ships two interchangeable
inference runtimes behind one interface, the same provider-swap shape M0 uses for
KYC rails and M1 uses for Account Aggregators:

| Runtime | Where it runs | Explanations | Default |
|---|---|---|---|
| `scorecard` | in-process (NestJS) | **exact** Shapley values, analytic | ✅ `ML_MODE=scorecard` |
| `fastapi` | this service | exact TreeSHAP over a gradient-boosted ensemble | `ML_MODE=fastapi` |

The in-process scorecard is additive, so each feature's Shapley value has a
closed form — `φᵢ = a·wᵢ·(tᵢ(xᵢ) − tᵢ(refᵢ))` — and reconciles to the score
exactly. It needs no Python, no artefact, and no network hop, which is why it is
the default: a reputation score should not be undeliverable because a sidecar is
down.

This service exists for the case the scorecard genuinely cannot cover: **feature
interactions**. An additive model cannot learn "a high balance only matters when
income is irregular"; a tree ensemble can. When you want that, register a version
with `runtime: "fastapi"` and point `ML_BASE_URL` here.

Which runtime answered is recorded on `Score.servedBy`, so the audit trail always
names the true author of a number.

## Python version

Verified end to end on **Python 3.14.0** with numpy 2.4.6, scikit-learn 1.9.0,
xgboost 3.3.0, shap 0.52.0 — wheels only, no source build. `xgboost` and `shap`
occasionally lag a brand-new CPython by a release; if `pip install` starts building
from source on yours, use the Dockerfile (pinned to 3.12). `train.py` also degrades
to sklearn's `HistGradientBoosting` when xgboost is missing, so TreeSHAP stays
exact either way.

## Run it

```bash
cd apps/ml

py -3.14 -m venv .venv          # or your interpreter
.venv\Scripts\Activate.ps1      # PowerShell
# source .venv/Scripts/activate # Git Bash    · source .venv/bin/activate on POSIX

pip install -r requirements.txt

# 1. Train. Writes models/model.joblib + models/feature_schema.joblib, prints the
#    metrics, the fairness back-test, and a ready-to-post registration payload.
#    Pick a version the registry does NOT already hold — versions are immutable, so
#    re-registering 1.0.0 (seeded as a scorecard version) is a 409.
python -m app.train --version 1.2.0

# 2. Serve. MODEL_VERSION must match the artefact, or /predict returns 409.
MODEL_VERSION=1.2.0 uvicorn app.main:app --host 0.0.0.0 --port 8100
```

Last verified run of `v1.2.0`:

```
AUC 0.7352 · Brier 0.1962 (isotonic) · score p10/50/90 = 600/709/780
POOR 6.6%  FAIR 24.9%  GOOD 37.9%  VERY_GOOD 26.7%  EXCELLENT 3.9%
Fairness back-test: PASSED on blocking attributes, 6 monitored age metrics
```

### The score scale is fitted, not assumed

`300 + 600·P(good)` does not work — it inherits the base rate. This DGP is ~26%
"good", which put the median at **516 with 69% in POOR**; a realistic 90%-good
portfolio would pile everyone above 840. In both cases the bands stop
discriminating. So `train.py` fits an affine map in **log-odds** space against
target deciles (p10→600, p90→780) and stores it in the artefact alongside the
estimator. That is how scorecards have always been built, and it is also what keeps
this runtime's distribution comparable to the in-process scorecard's — otherwise
activating one over the other would shift every user by 200 points and set off the
drift monitor.

Then on the NestJS side:

```dotenv
ML_MODE=fastapi
ML_BASE_URL=http://localhost:8100
```

…register the printed payload via `POST /api/v1/admin/score/models`, run
`POST /api/v1/admin/score/models/:id/audit-fairness`, and only then activate it.
Registration does not make a version servable — the fairness gate does.

### Docker

```bash
# From the repo root (the Dockerfile copies apps/ml, so the root is the context).
docker compose --profile ml up -d --build ml
```

## Endpoints

All internal-only. Never expose this port to a client: anyone who can call
`/predict` directly can shop for a score.

| Route | Purpose |
|---|---|
| `GET /health` | Liveness **and** artefact readiness, reported separately. Does not 503 on a missing model — restarting a container will not conjure an artefact, so the operator needs to know which problem they have. |
| `POST /predict` | Score + band + calibrated probability + exact TreeSHAP contributions + confidence decomposition + `raw_margin`. |
| `POST /counterfactual` | Score under a single-feature intervention. This is where "would add ~30 points" comes from — a re-run, not a SHAP value scaled by a magic constant. |
| `POST /fairness` | Disparate impact (four-fifths rule), demographic parity, and equal opportunity where labels exist — each paired with a significance test. |

### What `raw_margin` is for, and the calibration caveat

TreeSHAP is exact for the base estimator's margin: `raw_margin == base_value +
Σ shap_value`, measured at `2.22e-16`. `raw_margin` is returned so you can check
that rather than take it on trust.

But the score comes from the **isotonic-calibrated** probability, which differs from
the raw one (0.777 vs 0.817 on the demo profile). So the contributions do not sum to
the logit of the score-determining probability. Isotonic calibration is
piecewise-constant; no exact tree attribution of it exists.

What holds: calibration and the score map are both monotone, so `raw margin →
calibrated probability → score` is monotone end to end. The contributions explain,
exactly, the quantity that determines the score's **ordering** — every driver's
sign, magnitude and rank is faithful. Only their sum is not the score. (The
in-process scorecard has no such caveat; its calibration is affine in logit space,
so it reconciles with residual exactly 0.)

### Fairness metrics are paired with a significance test

The four-fifths rule is a point estimate of a ratio of two proportions and is
dominated by sampling noise at small n. The first real back-test flagged
`gender:other` at 0.792 and `nationality:US` at 0.705 on a population where those
attributes are generated **independently of every feature** — so the disparities
could not have been real. A metric now fails only when the gap is both materially
large and significant at α=0.05 (pooled two-proportion z). Disparate impact is
tested against the best group; demographic parity against the group's complement,
so the most-favoured group can fail parity too.

Verified in both directions: a gender gap routed through `avg_balance` does **not**
bias this model (DI 0.914, z=−1.69, not significant — the model is
behaviour-weighted and barely uses balance), while the same gap routed through
`income_regularity` is caught and blocks (DI 0.687, z=−5.50).

### Version mismatch is a 409, on purpose

NestJS stamps the *requested* model version onto the `Score` row. If this service
answered as a version it is not, every affected score would be unreproducible and
the audit trail would be a lie. So a mismatch is refused; the Nest side keeps the
prior score and does **not** trip its circuit breaker (a config error is not an
outage).

## The training data, stated plainly

There is no public dataset of Indian AA features with repayment outcomes, so
`train.py` generates a synthetic population from an explicit data-generating
process. The model is only as good as those assumptions, and they are all in one
readable function so a reviewer can argue with them.

Two properties are engineered in deliberately:

1. **Protected attributes correlate with the features but are never inputs.**
   Younger subjects really do have shorter histories, so a model that sees only
   `months_covered` can still produce an age disparity. That is the point —
   dropping the attribute does not delete the bias, so the outcome has to be
   measured. It also means the fairness audit finds something real instead of
   confirming a tautology.
2. **The outcome depends on trend features, not balances.** 12% of the synthetic
   population parks a lump sum for the data window: high `avg_balance`, low
   `balance_retention`, poor repayment. A model fitted on this cannot be gamed by
   parking money — the anti-gaming claim in M2 §12 is in the training data, not
   just in the prose.

Calibration is isotonic and is not optional: ranking correctly is not enough when
the probability gets multiplied by 600 and shown to someone as their score. An
uncalibrated 0.80 that should be 0.65 is ninety points of lie.

## Files

```
app/
  schema.py     ordered feature contract, band cutoffs, neutral imputation,
                confidence formula, fitted log-odds score scale
  model.py      artefact loading + TreeSHAP wrapper + raw_margin (lazy, cached)
  fairness.py   pure group metrics + the two-proportion significance test
  main.py       FastAPI transport shell
  train.py      synthetic population, fit, calibrate, fit the scale, back-test
```

These must stay numerically identical to their NestJS counterparts — two
implementations of the confidence formula or the four-fifths rule that disagree
would be worse than one:

| Python | TypeScript |
|---|---|
| `schema.compute_confidence` | `scoring.state.ts → computeConfidence` |
| `schema.NEUTRAL` / `OPTIONAL_FEATURES` | `model-catalog.ts → SCORECARD_V1.reference` / `OPTIONAL_FEATURES` |
| `fairness.two_proportion_z` | `fairness.service.ts → twoProportionZ` (and the seed's copy) |
| `fairness.MIN_GROUP_SIZE` / `BLOCKING_ATTRIBUTES` | `fairness.service.ts → MIN_GROUP_SIZE` / `BLOCKING_ATTRIBUTES` |

`apps/pravaah-be/scripts/verify-scoring.ts` asserts the TypeScript side offline.

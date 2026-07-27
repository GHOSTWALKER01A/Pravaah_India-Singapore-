# M2 · Reputation Engine — implementation notes

What M1's consented data becomes: a portable 300–900 score that explains itself,
admits what it doesn't know, and cannot be shipped without a bias audit.

Read this alongside `docs/api-tests/m2-scoring.http` (the runnable demo arc) and
`scripts/verify-scoring.ts` (the offline self-check).

---

## 1. Where everything lives

```
src/modules/scoring/
  scoring.route.ts                    SCORE_ROUTES + ADMIN_SCORE_ROUTES
  scoring.state.ts                    PURE maths: transforms, bands, confidence,
                                      lifecycle transitions, the thin-file gate
  model-catalog.ts                    the three shipped versions + their weights
  score.controller.ts                 user API  (JWT, scoped to req.user.id)
  admin-score.controller.ts           admin API (AdminAuthGuard + AdminRolesGuard)
  providers/
    inference.provider.ts             the rail contract
    local-scorecard.provider.ts       in-process additive model, EXACT Shapley
    fastapi-inference.provider.ts     external XGBoost + TreeSHAP + breaker
    inference-registry.ts             routes by ModelVersion.runtime
  services/
    feature-assembler.service.ts      M1 FiNormalized -> ordered vector + hash
    explanation.service.ts            contributions -> sentences + counterfactuals
    scoring.service.ts                the orchestrator
    model.service.ts                  registry + THE ACTIVATION GATE
    fairness.service.ts               the bias audit
    score-admin.service.ts            audit view + band override
    score-lifecycle.service.ts        expiry, retry, drift crons

apps/ml/                              optional FastAPI service (see its README)
scripts/verify-scoring.ts             DB-free assertion of M2's four claims
```

`scoring.state.ts` is deliberately I/O-free. Every number a user sees — the band,
the confidence interval, the transform of a raw feature — comes out of it, so the
API, the crons, the seed, and the admin console can never disagree about what a
score means.

---

## 2. The two inference runtimes

M2 follows the same provider-swap shape as M0's KYC rails and M1's Account
Aggregators, because the reason is the same: an external dependency must not be
able to take the product down.

| | `scorecard` (default) | `fastapi` |
|---|---|---|
| Runs in | NestJS process | `apps/ml` |
| Model | additive, on the logit scale | gradient-boosted trees (XGBoost) |
| Explanations | **exact** Shapley, closed form | exact TreeSHAP (see the caveat below) |
| Reconciles to the score | yes, residual **0** | no — calibration sits in between |
| Needs | nothing | Python, an artefact, a network hop |
| Use when | always, by default | you need feature **interactions** |

Both were run end to end. Verified on Python 3.14.0 with numpy 2.4.6,
scikit-learn 1.9.0, xgboost 3.3.0, shap 0.52.0. Trained `v1.2.0`: AUC 0.7352,
Brier 0.1962 after isotonic calibration, score p10/50/90 = 600/709/780.

### The calibration caveat on the `fastapi` runtime

TreeSHAP is exact for the base estimator's **margin** — measured additivity gap
`2.22e-16` against the `raw_margin` the API now returns for exactly this check.
But the score is computed from the **isotonic-calibrated** probability, which
differs from the raw one (0.777 vs 0.817 on the demo profile). So on this runtime
the contributions do **not** sum to the logit of the score-determining
probability. Isotonic calibration is piecewise-constant; no exact tree attribution
of it exists, and KernelExplainer would only approximate it far more slowly.

What still holds: calibration and the score map are both monotone, so
`raw margin → calibrated probability → score` is monotone end to end. The
contributions therefore explain, exactly, the quantity that determines the score's
**ordering** — every driver's sign, magnitude and rank is faithful. Only their sum
is not the score.

The in-process scorecard has no such caveat, and that is a real argument for it:
its calibration is an affine map in logit space folded into the weights, so
contributions scale linearly and reconcile with a residual of exactly 0.

Which one serves a request is decided by the **model version's own `runtime`
field**, not a global flag — the runtime is a property of the model, and a
gradient-boosted version cannot be served by an additive scorecard. `ML_MODE`
only decides what happens when the declared runtime is unreachable.

Whichever answered is recorded on `Score.servedBy`, so the audit names the true
author of a number even when a fallback served it.

### Why the scorecard's explanations are exact, not approximate

The model is additive:

```
z = a · ( intercept + Σᵢ wᵢ · tᵢ(xᵢ) ) + b        p = σ(z)        score = 300 + 600p
```

For any additive model the Shapley value of feature *i* has a closed form — its
own centred term — because there are no interaction terms for the other players
to share credit for:

```
φᵢ = a · wᵢ · ( tᵢ(xᵢ) − tᵢ(refᵢ) )        and        z = base_value + Σᵢ φᵢ
```

These are not "SHAP-like" numbers from a sampled approximation; they are the
Shapley values, computed analytically. `scripts/verify-scoring.ts` asserts the
additivity residual is under 1e-9 (it measures ~1e-16).

Contributions are reported in **margin space**, as XGBoost/TreeSHAP does. Point
impact is a separate question, answered by re-running the model — see §5.

---

## 3. Features

Nine features, no protected attributes, fixed order. The order is the contract
between `FeatureAssemblerService` and every runtime: a score is only reproducible
from its `inputsHash` if the vector was built in the registered order.

| Feature | From M1 | Notes |
|---|---|---|
| `monthly_inflow` | `totalInflow ÷ monthsCovered` | **Deviates from the spec's §6** — see below |
| `income_regularity` | `1/(1+CV)` of monthly credits | heaviest weight; behaviour, not wealth |
| `avg_balance` | mean transaction balance | capped weight — proxies age |
| `balance_retention` | `closingBalance ÷ peakBalance` | the park-and-withdraw penalty |
| `obligation_ratio` | `outflow ÷ inflow` | |
| `months_covered` | distinct credit months | capped weight — proxies age |
| `bounce_count` | narration match on returns | absence genuinely means zero |
| `gst_turnover` | GSTR summary | optional |
| `gst_filing_consistency` | filed months, late filings penalised | optional |

### Two deliberate deviations from the spec

**`total_inflow` became `monthly_inflow`.** A raw sum over a variable-length data
range is not comparable between users and silently double-counts
`months_covered` — the same salary over six months looks like a third of the
income it does over eighteen. The fairness audit surfaced it as an age disparity,
because younger applicants have shorter windows. A monthly rate is both the
honest income proxy and what the spec says the feature is *for*.

**`balance_retention` is closing÷peak, not trough÷peak.** Trough÷peak punishes a
saver whose balance grows (their trough is early and low). Closing÷peak gives a
genuine accumulator ~1.0 and a park-and-withdraw pattern ~0.1, which is the
behaviour the feature exists to separate.

### Optional features are "not applicable", not "missing"

An absent `gst_*` value does not reduce `completeness`. A salaried user has no GST
filings to share, and widening their confidence band for not running a business
would penalise the wrong thing. We cannot distinguish "has no GSTIN" from "has one
and didn't share it" from the features alone, so not-applicable is the only honest
reading. `missingCount` counts required features only.

---

## 4. Confidence, and the band the user sees

```
confidence = coverage × certainty × completeness
```

- `coverage` — how much of the expected data the AA actually delivered (M1)
- `certainty` — `0.5 + 0.5·|2p − 1|`, bounded so a borderline call widens the band
  without collapsing confidence on its own
- `completeness` — share of **required** features that survived without imputation

All three components are returned, not just the product, so a low number is
explainable: the console can say which term dragged it down instead of showing an
unaccountable `0.31`.

The visible interval is `±round(80 · (1 − confidence))`, floored at 8 points. In
practice:

| Profile | confidence | interval |
|---|---|---|
| Seeded demo file, bank + GST | 0.75 | **779** ± 20 |
| Same file, bank data only | 0.63 | **732** ± 30 |
| 2 months, four features imputed | 0.09 | **578** ± 73 |

A thin file gets a visibly wide band **and is told so** — the alternative, a crisp
number from two months of data, is the dishonesty M2 exists to avoid. Below two
months of history (and with no GST filing record) the engine refuses outright with
`INSUFFICIENT_DATA` rather than scoring an almost-entirely-imputed vector.

---

## 5. Explanations and counterfactuals

**Why this score** reads the contributions from the *same prediction call* that
produced the value, so the explanation cannot drift from the number.

**How to improve** re-runs the model with one feature moved to a target and
everything else held, and reports the true score delta. The spec's shortcut
(`|shap| × 40`) would be a fabricated number: contributions live in log-odds space
and the score is a non-linear squash of them, so points are not additively
decomposable. A tip that would gain nothing is dropped entirely, which is why an
empty improvement list is a legitimate outcome.

Features with no honest advice available return no target at all —
`monthly_inflow`, `gst_turnover` and `bounce_count`. Telling someone to earn more,
or to not have bounced a payment last November, is not advice. They stay in the
"why" panel only.

---

## 6. Fairness: the activation gate

**Protected attributes are never model inputs, but outcomes are always tested
across them.** `gender`, `ageBand` and `nationality` are collected under a
separate explicit consent, stored field-encrypted, and read by exactly one caller:
`FairnessService`. Blind when scoring, sighted when auditing.

That asymmetry is the point. Both naive alternatives are worse — feeding the
attributes in is unlawful, and refusing to collect them leaves you unable to prove
anything.

### Blocking vs monitored attributes

| Attribute | Mode | Why |
|---|---|---|
| `gender` | **blocking** | No legitimate business reason for approval rates to differ. A gap means the model found a proxy; the deploy is refused. |
| `nationality` | **blocking** | A cross-border reputation passport that scored by nationality would defeat its own purpose. |
| `age_band` | monitored | Creditworthiness genuinely varies with age. ECOA / Reg B (12 CFR 1002.6(b)(2)) permits age in an empirically derived, demonstrably sound system, and the four-fifths rule is applied in credit chiefly to sex/race/national origin. |

Hard-blocking on age would mean no model could ever ship, which in practice means
the gate gets disabled and stops protecting anything. Instead the age gap is
computed, stored, shown at the top of the dashboard with its mitigation path, and
**designed against** — see below.

### What the audit actually changed about the model

This is not a hypothetical. Two rounds of the audit forced two model changes:

1. `months_covered` was weighted 0.90 and used a linear 0→24 ramp. The audit
   failed v1.0.0 on `age_band` — 18–25 approval near zero — even though the model
   never sees an age. Fixed by saturating the transform (`logScale`) and cutting
   the weight.
2. That moved the failure to `avg_balance`, because savings proxy age just as
   well. The lesson generalises: **every wealth-or-tenure feature is an age
   proxy**, so they have to be capped *together*, not swapped one for another.

The resulting split — enforced by `verify-scoring.ts` — is behaviour 67%, wealth
and tenure 22%, business record 11%. Which is also PRAVAAH's whole premise: if
accumulated wealth and tenure dominate the score, thin-file users cannot be scored
at all, and there was no point building an alternative-data engine.

### Methodology notes worth defending

- **The ratio alone is not enough — every metric is paired with a significance
  test.** The four-fifths rule is a point estimate of a *ratio of two proportions*,
  and at small n it is dominated by sampling noise. This was not theoretical: the
  first real ML back-test flagged `gender:other` at DI 0.792 and `nationality:US`
  at 0.705 on a population where **gender and nationality are generated
  independently of every feature**, so those disparities could not possibly have
  been real. A metric now fails only when the gap is *both* materially large *and*
  significant at α=0.05 under a pooled two-proportion z-test. That pairing is the
  standard adverse-impact methodology — practitioners have never used the 80% rule
  on its own. After the change, all gender and nationality metrics pass on that
  population, and the genuinely-biased v0.9.0 still fails at DI 0.67, z=−5.5.
- **Minimum group size 30.** Even with the significance test, a group too small for
  a usable proportion estimate does not decide the gate. Smaller groups are still
  computed and reported — hiding them would hide real gaps.
- **Disparate impact is tested against the best group; parity against the
  group's complement.** The ratio is *defined* against the best group. Parity is
  not: it asks whether a group is treated differently from the rest of the
  population, so its comparison set is everyone else. Testing parity against the
  best group is a bug I shipped and then caught — it meant the most-favoured group
  was compared with itself and could never fail, so `age_band:60+` sat 0.206 above
  the population rate and was reported as passing. Being the group that benefits by
  twenty points is a parity finding too.
- **Disparate impact is measured within an attribute.** Dividing a gender approval
  rate by a nationality approval rate is arithmetic without meaning.
- **Candidates are re-scored, not read from stored outputs.** Auditing v1.1 against
  v1.0's outputs would measure the wrong model.
- **Equal opportunity is omitted, not faked.** It needs ground-truth repayment
  outcomes, which a pre-lending engine does not have. Emitting a fabricated TPR
  would be worse than the honest gap; enabling it is the fourth listed mitigation.

### The seeded cohort

`npm run prisma:seed` creates 200 consented subjects from a fixed seed (50 per
gender, 40 per age band, 100 per nationality — every group clears the
decisiveness floor) and runs the **real** audit over them, so the dashboard has
earned numbers on first boot rather than asserted ones.

One property is engineered in from a real, documented pattern: women in India hold
materially lower average balances at comparable incomes, while their repayment
behaviour is at least as good. So `avg_balance` is a gender proxy and behaviour
features are not — which is exactly why the balance-weighted v0.9.0 launders
gender and fails the audit, and the behaviour-weighted v1.0.0 passes. Neither
model ever sees a gender.

---

## 7. Anti-gaming

Every feature is a trend or a ratio, never a point-in-time balance.

`scripts/verify-scoring.ts` asserts the outcome directly: given a genuine saver
(₹1.2L average, 92% retention) and a parker (₹4.8L average, 12% retention),
v1.0.0 ranks the saver **above** the parker, and the balance-weighted v0.9.0 ranks
them the wrong way round. v0.9.0 stays registered precisely as that cautionary
exhibit.

`boundarySpikeRatio` — the share of inflow arriving in the first or last month of
the data window — is computed by M1 and carried into the audit metadata. It is
deliberately **not** a model input: it is a review flag, not a score adjustment.

---

## 8. Every §13 edge case, and where it is handled

| Edge case | Handling |
|---|---|
| No consent / no data | `ScoringService.compute` guard 2 → `NO_CONSENT` |
| Not identity-verified | guard 1 → 403 (a score is an assertion about a verified person) |
| Thin file (<2 months, no inflow, no GST) | `hasEnoughData` → `INSUFFICIENT_DATA`, value/band cleared |
| Partial data (some FIPs) | M1 coverage ↓ → confidence ↓ → wider band |
| Missing individual feature | imputed at the **reference** value (contributes exactly 0) + completeness penalty |
| Missing optional feature | not-applicable: no completeness penalty at all |
| Undecryptable normalised row | dropped with a logged error; lowers coverage, never crashes the compute |
| Consent revoked/expired after scoring | `ScoreLifecycleService.expireStale` → `EXPIRED`; `getCurrent` also re-checks at read time so a stale cron cannot serve a dead score |
| Data-life lapsed | same; the app routes to re-consent |
| Inference service down | circuit breaker → `FAILED` + last cached score served + 5-minute retry cron |
| Model version mismatch | FastAPI 409; NestJS keeps the prior score and does **not** trip the breaker |
| Duplicate/concurrent compute | `@@unique([userId, modelVersionId, inputsHash])` + upsert → one row, no race |
| Score gaming (balance parking) | trend features; asserted by `verify-scoring.ts` |
| Model unfair on a blocking group | audit fails → `ModelService.activate` refuses; the refusal is audited too |
| No model registered/active | 503 with an actionable message |
| Registering over an existing version | 409 — versions are immutable because scores are stamped with them |
| Activating a version whose runtime is unreachable | blocked, with the reason, unless `ML_MODE=auto` |
| Explanation/score mismatch | factors come from the same prediction call; written in one transaction with the score |
| Admin override abuse | senior role + 20-char mandatory reason + previous band recorded + permanent admin attribution; the model `value` is never rewritten |
| Overriding an EXPIRED/FAILED score | refused — there is no live assertion to amend |
| Drift over time | hourly cron + `GET /admin/score/drift` (same numbers, single source) |
| Cross-border interpretation | band cutoffs are stored per model version and travel with the M3 credential |
| PII in the score store | no raw financial data on `Score` — only value, band, confidence, `inputsHash`, and provenance |
| Protected attributes | encrypted, separately consented, audit-only; withdrawal deletes them |

---

## 9. Running it

```bash
# Backend (in-process scorecard — nothing else required)
cd apps/pravaah-be
npm run prisma:push          # M2 adds 7 tables + 3 enums; additive only
npm run prisma:seed          # registers 3 versions, seeds + audits the cohort
npm run dev

# Offline self-check — no DB, no network, no Python
npx tsx scripts/verify-scoring.ts

# Optional: the gradient-boosted runtime
cd apps/ml
py -3.14 -m venv .venv && .venv/Scripts/activate   # or your interpreter
pip install -r requirements.txt
python -m app.train --version 1.2.0                # a version NOT already registered
MODEL_VERSION=1.2.0 uvicorn app.main:app --port 8100
# then ML_MODE=fastapi + ML_BASE_URL=http://localhost:8100 in .env.development.local,
# and register + audit + activate the payload train.py prints.
```

`MODEL_VERSION` must match what you trained, and the version you register must be
one the registry does not already hold — versions are immutable, so re-registering
`1.0.0` is a 409. Mismatch the artefact version and `/predict` returns 409 rather
than answer as a model it is not.

`verify-scoring.ts` asserts the four claims M2 rests on — SHAP additivity,
anti-gaming ordering, honest confidence widening, and the fairness gate blocking
the right model. If a weight is retuned and one of those breaks, it fails there
rather than in front of a user.

---

## 10. Front-end surfaces

**RN app** — `Reputation` is a top-level tab, not a detail behind the passport.
The same `ReputationScreen` component backs both the tab and the pushed
`/(app)/score` route, so the two can't drift; only the route files differ, and
only in their navigator options.

| Screen | Notes |
|---|---|
| Reputation (tab) | Band meter with the confidence **interval on the same axis** as the score — an arc would make the band read as decoration. Why / Improve tabs. |
| Score history | Sparkline scaled to the user's own observed range, not 300–900, so a 40-point move is visible. Every row shows its model version, because a jump can mean "your behaviour changed" *or* "we changed the model". |
| Fairness consent | Leads with what it does **not** do, since that's the part a user will assume wrongly. Values are never read back from the server, so the form starts empty each visit — the app has no reason to display someone's gender. |

The passport teaser shows the interval too. A summary that dropped it would undo
the honesty the full screen works for: 573 ±73 and 573 ±10 mean different things.

**Admin console** — the overview leads with the two things that can be actively
wrong: no active model (that's an outage — every compute 503s) and score drift
away from the audited population. Then the registry (with the gate), the bias
dashboard, issued scores, and a paste-the-payload register form. It's a paste form
on purpose: `train.py` prints the exact JSON, and retyping a feature schema is how
an artefact and its registry entry drift apart.

## 11. Output for M3

A `COMPUTED` score carries everything M3 needs to mint a Verifiable Credential
without recomputation: `value`, `band`, `confidence`, the interval, the band
cutoffs that define what "GOOD" means, the model version and runtime, the factor
list, and `inputsHash` + `consentId` as provenance. `ScoringModule` exports
`ScoringService` and `FeatureAssemblerService` for exactly that.

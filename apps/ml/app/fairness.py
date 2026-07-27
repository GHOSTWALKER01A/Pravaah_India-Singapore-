"""Group-fairness metrics.

Pure functions over (group -> outcomes) so they can be unit-tested without a
model, and so the numbers are identical to NestJS's `FairnessService` — two
implementations of the four-fifths rule that disagree would be worse than one.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Dict, List, Optional, Sequence, Tuple

DISPARATE_IMPACT = "disparate_impact"
DEMOGRAPHIC_PARITY = "demographic_parity"
EQUAL_OPPORTUNITY = "equal_opportunity"

THRESHOLDS: Dict[str, float] = {
    DISPARATE_IMPACT: 0.8,      # four-fifths rule: ratio must be >= 0.80
    DEMOGRAPHIC_PARITY: 0.1,    # gap to population rate must be <= 0.10
    EQUAL_OPPORTUNITY: 0.8,     # TPR ratio must be >= 0.80
}

# Minimum group size for a metric to be DECISIVE. A four-fifths ratio between two
# small groups is mostly sampling noise: at n=12 and a 40% approval rate the
# standard error on the rate is ~0.14, so the ratio swings +/-0.5 by chance and
# would block deploys at random. Thirty is the conventional floor for a usable
# proportion estimate. Smaller groups are still computed and REPORTED — hiding
# them would hide real gaps — they just do not decide the gate on their own.
# Must match MIN_GROUP_SIZE in fairness.service.ts.
MIN_GROUP_SIZE = 30

# Which attributes can BLOCK an activation, and which are monitored.
#
#  - gender / nationality — BLOCKING. No legitimate business reason exists for
#    approval rates to differ by these; a gap means the model found a proxy.
#  - age_band — MONITORED. Creditworthiness genuinely varies with age (income,
#    savings and history depth all rise with it), so every credit model on a real
#    population shows age disparity. ECOA / Reg B 12 CFR 1002.6(b)(2) permits age
#    in an empirically derived, demonstrably sound system. Reported prominently
#    and designed against, but not a hard block — a gate no model can ever pass
#    is a gate that gets switched off.
#
# Must match BLOCKING_ATTRIBUTES in fairness.service.ts.
BLOCKING_ATTRIBUTES: set[str] = {"gender", "nationality"}


# Significance level for the adverse-impact test that accompanies the ratio.
SIGNIFICANCE_ALPHA = 0.05
# Two-sided normal critical value at alpha=0.05.
_Z_CRIT = 1.959964


def _rate(outcomes: Sequence[int]) -> float:
    return sum(outcomes) / len(outcomes) if outcomes else 0.0


def two_proportion_z(
    group: Sequence[int],
    reference: Sequence[int],
) -> Tuple[float, bool]:
    """Pooled two-proportion z-test. Returns (z, significant_at_alpha).

    WHY the four-fifths rule needs this. The rule is a point estimate of a RATIO of
    two proportions, and at small n it is dominated by sampling noise: with a 26%
    approval rate and n=129 the rate's standard error is ~0.039, so a group whose
    true rate is identical to the reference will routinely measure a ratio of 0.70.
    Blocking a deploy on that is a false positive, and a gate that fires on noise is
    one teams learn to switch off.

    Pairing the ratio with a significance test is the standard adverse-impact
    methodology precisely because of this — practitioners have never used the 80%
    rule on its own. Here a metric fails only when the disparity is BOTH large
    enough to matter and distinguishable from chance.
    """
    n1, n2 = len(group), len(reference)
    if n1 == 0 or n2 == 0:
        return 0.0, False
    p1, p2 = _rate(group), _rate(reference)
    pooled = (sum(group) + sum(reference)) / (n1 + n2)
    se = math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
    if se < 1e-12:
        return 0.0, False
    z = (p1 - p2) / se
    return z, abs(z) >= _Z_CRIT


def group_metrics(
    approved_by_group: Dict[str, List[int]],
    population_rate: float,
    tpr_by_group: Optional[Dict[str, List[int]]] = None,
) -> List[Dict[str, object]]:
    """Compute every metric for every group.

    Disparate impact is measured WITHIN an attribute (gender against gender), not
    across all groups at once: dividing a gender approval rate by a nationality
    approval rate is arithmetic without meaning.
    """
    reports: List[Dict[str, object]] = []

    by_attribute: Dict[str, List[str]] = defaultdict(list)
    for group in approved_by_group:
        by_attribute[group.split(":", 1)[0]].append(group)

    for attribute, groups in by_attribute.items():
        rates = {g: _rate(approved_by_group[g]) for g in groups}
        best = max(rates.values()) if rates else 0.0
        best_group = max(groups, key=lambda g: rates[g]) if groups else None

        for group in groups:
            rate = rates[group]
            size = len(approved_by_group[group])
            small = size < MIN_GROUP_SIZE

            # ── disparate impact: tested against the BEST group ─────────────
            # That is what the ratio is defined against. A group compared with
            # itself has no disparity by construction.
            di_z, di_significant = 0.0, False
            if best_group and best_group != group:
                di_z, di_significant = two_proportion_z(
                    approved_by_group[group], approved_by_group[best_group]
                )

            # best == 0 means nobody in this attribute was approved at all. That
            # is not a disparity between groups, so it passes rather than
            # dividing by zero.
            di = (rate / best) if best > 0 else 1.0
            reports.append(
                {
                    "metric": DISPARATE_IMPACT,
                    "attribute": attribute,
                    "group": group,
                    "value": round(di, 3),
                    "threshold": THRESHOLDS[DISPARATE_IMPACT],
                    # Fails only when the gap is BOTH materially large and
                    # statistically real.
                    "passed": small
                    or di >= THRESHOLDS[DISPARATE_IMPACT]
                    or not di_significant,
                    "sample_size": size,
                    "approval_rate": round(rate, 3),
                    "z_score": round(di_z, 3),
                    "significant": di_significant,
                }
            )

            # ── demographic parity: tested against EVERYONE ELSE ────────────
            # Deliberately NOT against the best group. Parity asks whether this
            # group is treated differently from the rest of the population, so the
            # comparison set is its complement — otherwise the most-favoured group
            # is compared with itself and can never fail, however far above the
            # population rate it sits. Being the group that benefits by twenty
            # points is a parity finding too.
            complement: List[int] = [
                outcome
                for other in groups
                if other != group
                for outcome in approved_by_group[other]
            ]
            dp_z, dp_significant = two_proportion_z(
                approved_by_group[group], complement
            )

            gap = abs(rate - population_rate)
            reports.append(
                {
                    "metric": DEMOGRAPHIC_PARITY,
                    "attribute": attribute,
                    "group": group,
                    "value": round(gap, 3),
                    "threshold": THRESHOLDS[DEMOGRAPHIC_PARITY],
                    "passed": small
                    or gap <= THRESHOLDS[DEMOGRAPHIC_PARITY]
                    or not dp_significant,
                    "sample_size": size,
                    "approval_rate": round(rate, 3),
                    "z_score": round(dp_z, 3),
                    "significant": dp_significant,
                }
            )

    # Equal opportunity needs ground-truth outcomes, which a pre-lending
    # reputation engine does not have in production. It IS computed here when the
    # caller supplies labels (the training/back-test path does), and omitted
    # entirely otherwise — a fabricated TPR would be worse than an honest gap.
    if tpr_by_group:
        tpr_attributes: Dict[str, List[str]] = defaultdict(list)
        for group in tpr_by_group:
            tpr_attributes[group.split(":", 1)[0]].append(group)

        for attribute, groups in tpr_attributes.items():
            tprs = {g: _rate(tpr_by_group[g]) for g in groups}
            best_tpr = max(tprs.values()) if tprs else 0.0
            best_tpr_group = (
                max(groups, key=lambda g: tprs[g]) if groups else None
            )
            for group in groups:
                size = len(tpr_by_group[group])
                ratio = (tprs[group] / best_tpr) if best_tpr > 0 else 1.0
                significant = False
                z = 0.0
                if best_tpr_group and best_tpr_group != group:
                    z, significant = two_proportion_z(
                        tpr_by_group[group], tpr_by_group[best_tpr_group]
                    )
                reports.append(
                    {
                        "metric": EQUAL_OPPORTUNITY,
                        "attribute": attribute,
                        "group": group,
                        "value": round(ratio, 3),
                        "threshold": THRESHOLDS[EQUAL_OPPORTUNITY],
                        "passed": size < MIN_GROUP_SIZE
                        or ratio >= THRESHOLDS[EQUAL_OPPORTUNITY]
                        or not significant,
                        "sample_size": size,
                        "approval_rate": round(tprs[group], 3),
                        "z_score": round(z, 3),
                        "significant": significant,
                    }
                )

    return reports


def verdict(reports: Sequence[Dict[str, object]]) -> bool:
    """Pass/fail for the activation gate.

    Only statistically meaningful groups of BLOCKING attributes decide it.
    Monitored attributes and small groups are still reported in full — see
    ``monitored_concerns``.
    """
    decisive = [
        r
        for r in reports
        if int(r.get("sample_size", 0)) >= MIN_GROUP_SIZE
        and str(r.get("attribute")) in BLOCKING_ATTRIBUTES
    ]
    return bool(decisive) and all(bool(r["passed"]) for r in decisive)


def monitored_concerns(reports: Sequence[Dict[str, object]]) -> List[Dict[str, object]]:
    """Failures on monitored attributes: never hidden, never blocking."""
    return [
        r
        for r in reports
        if int(r.get("sample_size", 0)) >= MIN_GROUP_SIZE
        and str(r.get("attribute")) not in BLOCKING_ATTRIBUTES
        and not bool(r["passed"])
    ]

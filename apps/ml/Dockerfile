# pravaah-inference (M2) — model + SHAP + fairness.
#
# Pinned to 3.12 deliberately: xgboost/shap wheels lag the newest CPython, and a
# floating `python:3` base would break this image the week a new release lands.
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# libgomp is OpenMP — xgboost and sklearn both need it at runtime, and the slim
# base does not ship it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first so a code change does not re-resolve the (slow) ML wheels.
COPY apps/ml/requirements.txt ./requirements.txt
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY apps/ml/app ./app

# Train at build time so the image is self-contained: an inference container that
# boots with no artefact is a 503 waiting to happen.
RUN python -m app.train --version "${MODEL_VERSION:-1.0.0}"

ENV MODEL_PATH=/srv/models/model.joblib \
    FEATURE_SCHEMA_PATH=/srv/models/feature_schema.joblib \
    MODEL_VERSION=1.0.0 \
    PORT=8000

# Runs as a non-root user: this process evaluates a model over financial features
# and has no reason to hold root.
RUN useradd --create-home --uid 10001 pravaah && chown -R pravaah:pravaah /srv
USER pravaah

EXPOSE 8000

# /health reports artefact readiness without failing on a missing model, so this
# probe answers "is the process serving?" rather than "is it fully configured?".
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=20s \
    CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

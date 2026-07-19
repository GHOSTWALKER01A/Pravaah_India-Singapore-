FROM node:22-alpine AS pruner
RUN apk add --no-cache libc6-compat
WORKDIR /app
RUN npm install -g turbo@^2
COPY . .
# The root lockfile is gitignored, so CI needs to generate it before pruning.
RUN npm install --package-lock-only --ignore-scripts \
    && turbo prune urbuddy-be --docker

FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=4096

ARG SUPABASE_DIRECT_URL

# Prisma config loader validates SUPABASE_DIRECT_URL even during `prisma generate`
# (no DB connection is made — it just needs the var to exist).
# A placeholder value is sufficient; it is only set in this build stage.
ENV SUPABASE_DIRECT_URL=${SUPABASE_DIRECT_URL:-postgresql://build:build@localhost:5432/build}

COPY --from=pruner /app/out/full/ .
# Install from the pruned lockfile so the workspace graph matches the prune output.
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
RUN npm ci
RUN npx turbo run build --filter=urbuddy-be
# Inject Sentry Debug IDs into the exact JS/source maps that the runtime image
# will ship. Upload happens outside Docker so no Sentry auth token is baked into
# an image layer.
RUN npx --no-install sentry-cli sourcemaps inject apps/urbuddy-be/dist

RUN npm prune --omit=dev --workspaces --include-workspace-root \
    && npm cache clean --force

FROM scratch AS sentry-artifacts
COPY --from=builder /app/apps/urbuddy-be/dist /dist

FROM node:22-alpine AS runtime
RUN apk add --no-cache libc6-compat curl
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nestjs

COPY --from=builder /app/apps/urbuddy-be/dist ./dist
COPY --from=builder /app/apps/urbuddy-be/package.json ./
COPY --from=builder /app/apps/urbuddy-be/prisma/prod-ca-2021.crt ./prisma/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/dayjs ./packages/dayjs
COPY --from=builder /app/packages/nestjs-logger ./packages/nestjs-logger
COPY --from=builder /app/packages/urbuddy-schema ./packages/urbuddy-schema
COPY --from=builder /app/packages/notifications ./packages/notifications

USER nestjs

ENV NODE_ENV=production
EXPOSE 8000

CMD ["node", "dist/src/main.js"]

FROM node:22-alpine AS pruner
RUN apk add --no-cache libc6-compat
WORKDIR /app
RUN npm install -g turbo@^2
COPY . .
# The root lockfile is gitignored, so CI needs to generate it before pruning.
RUN npm install --package-lock-only --ignore-scripts \
    && turbo prune parvaah-be --docker

FROM node:22-alpine AS builder

RUN apk add --no-cache libc6-compat
WORKDIR /app

ENV NODE_OPTIONS=--max-old-space-size=4096

ARG DATABASE_URL

# Prisma config requires DATABASE_URL during prisma generate.
# This fallback is only for image build time.
ENV DATABASE_URL=${DATABASE_URL:-postgresql://build:build@localhost:5432/build}

COPY --from=pruner /app/out/full/ .

COPY --from=pruner /app/out/package-lock.json ./package-lock.json

RUN npm ci

RUN npx turbo run build --filter=parvaah-be

RUN npx --no-install sentry-cli sourcemaps inject apps/pravaah-be/dist

RUN npm prune --omit=dev --workspaces --include-workspace-root \
    && npm cache clean --force
FROM scratch AS sentry-artifacts
COPY --from=builder /app/apps/pravaah-be/dist /dist

FROM node:22-alpine AS runtime
RUN apk add --no-cache libc6-compat curl
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nestjs

COPY --from=builder /app/apps/pravaah-be/dist ./dist
COPY --from=builder /app/apps/pravaah-be/package.json ./
COPY --from=builder /app/node_modules ./node_modules
# Workspace packages pravaah-be depends on (node_modules symlinks resolve here).
COPY --from=builder /app/packages/nestjs-logger ./packages/nestjs-logger
COPY --from=builder /app/packages/pravaah-schema ./packages/pravaah-schema

USER nestjs

ENV NODE_ENV=production
EXPOSE 8000

CMD ["node", "dist/src/main.js"]

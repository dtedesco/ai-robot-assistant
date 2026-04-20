# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:20-alpine AS builder
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy workspace manifests first for better layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/robot-protocol/package.json packages/robot-protocol/tsconfig.json packages/robot-protocol/
COPY apps/api/package.json apps/api/tsconfig.json apps/api/

# Install all workspace deps.
RUN pnpm install --frozen-lockfile || pnpm install

# Copy sources.
COPY packages/shared/src packages/shared/src
COPY packages/robot-protocol/src packages/robot-protocol/src
COPY apps/api/prisma apps/api/prisma
COPY apps/api/src apps/api/src

# Build workspace deps first so @robot/shared resolves to dist/*.js at runtime.
RUN pnpm --filter @robot/shared run build
RUN pnpm --filter @robot/protocol run build
# Generate Prisma client + build API.
RUN pnpm --filter @robot/api exec prisma generate
RUN pnpm --filter @robot/api run build

# ---------- runner ----------
# We preserve the pnpm monorepo layout (apps/api alongside node_modules and
# packages/) because pnpm's node_modules is full of relative symlinks into
# `.pnpm/`, and breaking them causes resolution errors (`Cannot find
# package 'fastify'` etc.). Simpler to ship the whole tree — Alpine keeps
# the image small enough.
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0

# Prisma's linux-musl query engine links against libssl. Alpine 3.18+ ships
# OpenSSL 3 but doesn't include it in the base Node image, so Prisma
# defaults (wrongly) to the openssl-1.1.x binary and crashes on load.
RUN apk add --no-cache openssl

COPY --from=builder /repo /app

WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/server.js"]

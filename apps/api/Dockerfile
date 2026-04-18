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

# Generate Prisma client + build.
RUN pnpm --filter @robot/api exec prisma generate
RUN pnpm --filter @robot/api run build

# Bundle a self-contained deployable in /out.
RUN pnpm --filter @robot/api deploy --prod /out || \
    (mkdir -p /out && cp -r apps/api/dist /out/dist && \
     cp apps/api/package.json /out/ && \
     cp -r node_modules /out/node_modules)

# ---------- runner ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --from=builder /out/ ./
COPY --from=builder /repo/apps/api/prisma ./prisma

EXPOSE 3000
CMD ["node", "dist/server.js"]

###
# Build stage
###
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /repo

# Copy workspace manifests first for better caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile || pnpm install

# Copy sources
COPY packages/shared packages/shared
COPY apps/web apps/web

# Build shared first, then web
RUN pnpm --filter @robot/shared build && pnpm --filter @robot/web build

###
# Runtime stage (nginx)
###
FROM nginx:1.27-alpine AS runtime

# Defaults: docker-compose uses internal service name on port 3000 (http).
# For Cloud Run override both: API_UPSTREAM=api-xxx-uc.a.run.app API_SCHEME=https
ENV API_UPSTREAM=api:3000
ENV API_SCHEME=http

# Use the template mechanism for env substitution at container start.
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template
# Remove the stock default site so our template wins.
RUN rm -f /etc/nginx/conf.d/default.conf

COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

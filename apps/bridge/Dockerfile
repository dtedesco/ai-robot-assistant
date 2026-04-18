# syntax=docker/dockerfile:1.7
#
# Bridge daemon image.
#
# Uses node:20-bookworm-slim (NOT alpine) because @abandonware/noble depends on
# libudev / bluez userspace libs that aren't available on alpine.
#
# Runtime note: on Linux you must grant the container raw BLE access:
#
#   docker run \
#     --net=host \
#     --cap-add=NET_ADMIN \
#     --cap-add=NET_RAW \
#     -e API_WS_URL=wss://... \
#     -e BRIDGE_TOKEN=... \
#     robot-bridge
#
# Alternatively, set the capability on the node binary directly:
#   setcap cap_net_raw+eip $(which node)
#
# On macOS, prefer running the daemon outside Docker (native pnpm dev) because
# Docker Desktop does not expose the host Bluetooth adapter to containers.

# ---------- builder ----------
FROM node:20-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      pkg-config \
      libudev-dev \
      libbluetooth-dev \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@9.12.0 --activate

WORKDIR /repo

# Copy workspace manifests first for better layer caching.
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/robot-protocol/package.json packages/robot-protocol/
COPY apps/bridge/package.json apps/bridge/

RUN pnpm install --frozen-lockfile=false --filter=@robot/bridge...

# Copy sources.
COPY packages/shared packages/shared
COPY packages/robot-protocol packages/robot-protocol
COPY apps/bridge apps/bridge

RUN pnpm --filter=@robot/bridge build

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      bluetooth \
      bluez \
      libbluetooth3 \
      libudev1 \
      alsa-utils \
      libasound2 \
      sox \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Workspace packages (shared, robot-protocol) are TypeScript-only and resolve
# via workspace symlinks — we carry the whole compiled repo rather than just
# the bridge's dist/.
COPY --from=builder /repo /repo

ENV NODE_ENV=production
WORKDIR /repo/apps/bridge

# TODO(runtime): @robot/shared and @robot/protocol currently ship as .ts; we
# use tsx at runtime to avoid importing un-compiled TS from node dist/. Switch
# to `node dist/index.js` once shared packages emit their own dist output.
CMD ["pnpm", "exec", "tsx", "src/index.ts"]

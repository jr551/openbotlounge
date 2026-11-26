# syntax=docker/dockerfile:1

# Build once on the builder's native platform: the compiled app is plain JS,
# so emulating the whole Vite build for arm64 bought nothing but hours - a
# QEMU arm64 build hung for 6h in CI (2026-11-25, run 45658926987) while the
# native amd64 build finished in ~100s.
FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Production dependencies still resolve per target platform, so a future
# native prod dependency lands correctly on arm64 - this stage only installs
# the small prod tree, which emulation handles fine. --ignore-scripts: the
# package's own `prepare` runs svelte-kit sync, a dev tool this stage
# deliberately does not install; the prod tree carries no install scripts.
FROM node:24-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
# The bot machines' filtered way out to the internet; the app runs it as a
# sidecar container joined to each machine's internal network.
COPY egress-proxy.mjs ./
# The one-port forwarder that republishes a machine's desktop on the host's
# loopback; one sidecar container per machine, joined to both that machine's
# internal network and the gateway bridge.
COPY vnc-gateway.mjs ./
# The police's reference for refusal consultations (see consultRefusal in
# src/lib/server/police.ts); read from the working directory at runtime.
COPY GOOD_USE_GUIDE.md ./
# The computer operator's field guide (see computerGuideText in
# src/lib/server/computer-agent.ts); read from the working directory at runtime.
COPY COMPUTER_GUIDE.md ./
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
CMD ["node", "build"]

# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
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

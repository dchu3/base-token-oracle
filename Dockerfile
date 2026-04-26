# syntax=docker/dockerfile:1.7
#
# Multi-stage build for base-token-oracle + its Blockscout stdio MCP child.
#
# IMPORTANT: the build context must be the PARENT directory that contains
# all necessary repos:
#
#   <parent>/
#     base-token-oracle/      <-- this repo
#     dex-blockscout-mcp/
#
# Invoke with:
#   docker build -f base-token-oracle/Dockerfile -t base-token-oracle <parent>

############################
# Stage 1: build the MCP
############################
FROM node:20-alpine AS mcps-builder
WORKDIR /build

# dex-blockscout-mcp
COPY dex-blockscout-mcp/package.json dex-blockscout-mcp/package-lock.json* ./dex-blockscout-mcp/
RUN cd dex-blockscout-mcp && npm ci
COPY dex-blockscout-mcp/ ./dex-blockscout-mcp/
RUN cd dex-blockscout-mcp && npm run build

############################
# Stage 2: build the oracle
############################
FROM node:20-alpine AS oracle-builder
WORKDIR /build/oracle

COPY base-token-oracle/package.json base-token-oracle/package-lock.json* ./
RUN npm ci

COPY base-token-oracle/ ./
RUN npm run build

############################
# Stage 3: production-only deps
############################
FROM node:20-alpine AS prod-deps
WORKDIR /deps

COPY base-token-oracle/package.json base-token-oracle/package-lock.json* ./oracle/
RUN cd oracle && npm ci --omit=dev

COPY dex-blockscout-mcp/package.json dex-blockscout-mcp/package-lock.json* ./dex-blockscout-mcp/
RUN cd dex-blockscout-mcp && npm ci --omit=dev

############################
# Stage 4: lean runtime
############################
FROM node:20-alpine AS runtime

RUN apk add --no-cache curl tini \
 && addgroup -S oracle -g 10001 \
 && adduser -S -G oracle -u 10001 oracle

WORKDIR /app

# Oracle
COPY --from=oracle-builder --chown=oracle:oracle /build/oracle/package.json       /app/oracle/package.json
COPY --from=oracle-builder --chown=oracle:oracle /build/oracle/package-lock.json  /app/oracle/package-lock.json
COPY --from=prod-deps     --chown=oracle:oracle /deps/oracle/node_modules         /app/oracle/node_modules
COPY --from=oracle-builder --chown=oracle:oracle /build/oracle/dist               /app/oracle/dist
COPY --from=oracle-builder --chown=oracle:oracle /build/oracle/public             /app/oracle/public

# MCP: dex-blockscout-mcp
COPY --from=mcps-builder --chown=oracle:oracle /build/dex-blockscout-mcp/package.json      /app/mcps/dex-blockscout-mcp/package.json
COPY --from=mcps-builder --chown=oracle:oracle /build/dex-blockscout-mcp/package-lock.json /app/mcps/dex-blockscout-mcp/package-lock.json
COPY --from=prod-deps    --chown=oracle:oracle /deps/dex-blockscout-mcp/node_modules       /app/mcps/dex-blockscout-mcp/node_modules
COPY --from=mcps-builder --chown=oracle:oracle /build/dex-blockscout-mcp/dist              /app/mcps/dex-blockscout-mcp/dist

USER oracle
WORKDIR /app/oracle

ENV NODE_ENV=production \
    PORT=8080 \
    MCP_BLOCKSCOUT_CMD="node /app/mcps/dex-blockscout-mcp/dist/index.js"

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8080/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]

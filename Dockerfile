# syntax=docker/dockerfile:1
# Multi-arch (linux/amd64, linux/arm64) image: same image on an x86 server and a Raspberry Pi.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
# No compiler needed: better-sqlite3 and @node-rs/argon2 ship prebuilt binaries for
# linux x64 and arm64 (glibc), which is why the image is Debian-based rather than Alpine.
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
# --ignore-scripts: nothing we depend on needs an install script (native modules ship
# prebuilt binaries), and skipping them avoids running third-party code at build time.
RUN npm ci --ignore-scripts
COPY packages packages
RUN npm run build \
    && npm prune --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
COPY config.example.yaml ./
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/fa-entrypoint
RUN mkdir -p /data && chown node:node /data
# No USER here on purpose: the entrypoint starts as root only to fix /data ownership, then
# drops to PUID:PGID (default 1000:1000, the image's "node" user) before starting the app.
ENV PUID=1000 PGID=1000
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["fa-entrypoint"]
CMD ["node", "packages/server/dist/index.js"]

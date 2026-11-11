# syntax=docker/dockerfile:1.7
# Raft Review: Node 24 + Tectonic (server-side LaTeX compiles).

FROM node:24.16.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24.16.0-bookworm-slim
ARG TARGETARCH
ARG TECTONIC_VERSION=0.17.0
ARG TECTONIC_SHA256_AMD64=8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7
ARG TECTONIC_SHA256_ARM64=b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x86_64; sum="$TECTONIC_SHA256_AMD64" ;; \
      arm64) arch=aarch64; sum="$TECTONIC_SHA256_ARM64" ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/tectonic.tgz "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${arch}-unknown-linux-musl.tar.gz"; \
    echo "${sum}  /tmp/tectonic.tgz" | sha256sum -c -; \
    tar -xzf /tmp/tectonic.tgz -C /usr/local/bin tectonic; \
    rm /tmp/tectonic.tgz; \
    apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \
    useradd --system --create-home --uid 10001 app; \
    mkdir -p /data; chown app:app /data

USER app
ENV XDG_CACHE_HOME=/home/app/.cache
COPY --chown=app:app docker/warmup.tex /tmp/warmup/warmup.tex
RUN cd /tmp/warmup && tectonic -X compile warmup.tex --outdir . && rm -rf /tmp/warmup

WORKDIR /app
COPY --from=deps --chown=app:app /app/node_modules node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app src src
COPY --chown=app:app public public
COPY --chown=app:app scripts scripts

ENV NODE_ENV=production DATA_DIR=/data PORT=8787 COMPILER=tectonic
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "src/server.ts"]

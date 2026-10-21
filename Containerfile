# Getränkeliste – multi-stage image build: Podman (`make build`, see Makefile)
# or Docker (`docker compose build`, see compose.yaml).
#
#   frontend-build  npm ci + lint + typecheck + unit tests + build of the SPA
#   pocketbase      PocketBase binary, verified against the pinned SHA-256 (PB_SHA256_*)
#   test            Playwright image with PocketBase, SPA, API + E2E tests (`make test`)
#   app-files       migrations, hooks and SPA with normalized file permissions
#   runtime         the app image (last stage = default target, `make build`)
#
# HEALTHCHECK requires the docker image format: podman build --format docker

ARG PB_VERSION=0.40.4
# SHA-256 of the release zips, copied from the release's checksums.txt. That
# file comes from the same place as the zip, so it is only a cross-check.
# Change them together with PB_VERSION (and in scripts/dev-pocketbase.sh).
ARG PB_SHA256_AMD64=9042ec818570e79c3628dadcd0a756c1496d9e1173918ec409d133c02f82e5fa
ARG PB_SHA256_ARM64=86095bf8ed9345954f0d2bf0a5fb9b57584ae60b77ebf3b6cd23a8003a3fd418
ARG PB_SHA256_ARMV7=9460e0be425cf8c7ae8e58f0186c13b59478b99ccef5cf0f734d05448952284b
ARG PB_SHA256_PPC64LE=fde8d87375c3469ddc59b0287f37748c3e87e2abe215513b9ae3f6d2a054d4d0
ARG PB_SHA256_S390X=0363b7ad130974a13e4ea7702b57645200d4483a5d6c32fa5db6356ebd9f215b
# The E2E tests must pin @playwright/test to exactly this version.
ARG PLAYWRIGHT_VERSION=1.63.0
ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim
ARG ALPINE_IMAGE=docker.io/library/alpine:3.24

# --------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS frontend-build
LABEL io.getraenkeliste.project=getraenkeliste
ENV CI=true
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run lint \
 && npm run typecheck \
 && npm test \
 && npm run build

# --------------------------------------------------------------------------
FROM ${ALPINE_IMAGE} AS pocketbase
LABEL io.getraenkeliste.project=getraenkeliste
ARG PB_VERSION
ARG PB_SHA256_AMD64
ARG PB_SHA256_ARM64
ARG PB_SHA256_ARMV7
ARG PB_SHA256_PPC64LE
ARG PB_SHA256_S390X
ARG TARGETARCH
WORKDIR /tmp/pocketbase
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=amd64; pinned="${PB_SHA256_AMD64}" ;; \
      arm64) arch=arm64; pinned="${PB_SHA256_ARM64}" ;; \
      arm) arch=armv7; pinned="${PB_SHA256_ARMV7}" ;; \
      ppc64le) arch=ppc64le; pinned="${PB_SHA256_PPC64LE}" ;; \
      s390x) arch=s390x; pinned="${PB_SHA256_S390X}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    zip="pocketbase_${PB_VERSION}_linux_${arch}.zip"; \
    base="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}"; \
    wget -q -O "${zip}" "${base}/${zip}"; \
    wget -q -O checksums.txt "${base}/checksums.txt"; \
    echo "${pinned}  ${zip}" | sha256sum -c - \
      || { echo "${zip} does not match the pinned SHA-256 - update PB_SHA256_* with PB_VERSION" >&2; exit 1; }; \
    listed="$(awk -v f="${zip}" '$2 == f {print $1}' checksums.txt)"; \
    [ "${listed}" = "${pinned}" ] \
      || { echo "the release's checksums.txt lists '${listed}' for ${zip}, the pin is ${pinned}" >&2; exit 1; }; \
    unzip -q "${zip}" pocketbase; \
    install -m 0755 pocketbase /usr/local/bin/pocketbase; \
    rm -rf /tmp/pocketbase/*; \
    /usr/local/bin/pocketbase --version

# --------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS test
LABEL io.getraenkeliste.project=getraenkeliste
ARG PLAYWRIGHT_VERSION
ENV CI=true \
    PB_BIN=/usr/local/bin/pocketbase \
    PB_MIGRATIONS_DIR=/app/backend/pb_migrations \
    PB_HOOKS_DIR=/app/backend/pb_hooks \
    PB_PUBLIC_DIR=/app/frontend/dist \
    TEST_RESULTS_DIR=/app/test-results
WORKDIR /app
COPY --from=pocketbase /usr/local/bin/pocketbase /usr/local/bin/pocketbase

COPY backend/tests/package.json backend/tests/package-lock.json /app/backend/tests/
RUN cd /app/backend/tests && npm ci --no-audit --no-fund

# dependencies first (cached until package*.json change), sources below
COPY e2e/package.json e2e/package-lock.json /app/e2e/
RUN cd /app/e2e \
 && node -e 'const v = require("./package.json").devDependencies["@playwright/test"]; \
      if (v !== process.argv[1]) { console.error(`@playwright/test ${v} does not match the image (${process.argv[1]})`); process.exit(1); }' \
      "${PLAYWRIGHT_VERSION}" \
 && npm ci --no-audit --no-fund

COPY backend/ /app/backend/
COPY e2e/ /app/e2e/
COPY --from=frontend-build /src/frontend/dist /app/frontend/dist
COPY --chmod=0755 scripts/ci-test.sh /app/scripts/ci-test.sh
CMD ["/app/scripts/ci-test.sh"]

# --------------------------------------------------------------------------
# The app files for the runtime image. COPY keeps the file modes of the build
# context (and Vite keeps those of frontend/public): a checkout made with a
# strict umask (e.g. 027 -> files 0640, dirs 0750) would be unreadable for the
# non-root runtime user. Normalize to "owner rw, everyone read, dirs traversable".
FROM ${ALPINE_IMAGE} AS app-files
LABEL io.getraenkeliste.project=getraenkeliste
COPY backend/pb_migrations /app/pb_migrations
COPY backend/pb_hooks /app/pb_hooks
COPY --from=frontend-build /src/frontend/dist /app/pb_public
RUN chmod -R u=rwX,go=rX /app

# --------------------------------------------------------------------------
FROM ${ALPINE_IMAGE} AS runtime
LABEL io.getraenkeliste.project=getraenkeliste \
      org.opencontainers.image.title="Getränkeliste" \
      org.opencontainers.image.description="Drinks tally: PocketBase backend serving the React SPA"
RUN addgroup -S -g 10001 pocketbase \
 && adduser -S -D -H -u 10001 -G pocketbase -h /pb_data -s /sbin/nologin pocketbase \
 && mkdir -p /pb_data \
 && chown pocketbase:pocketbase /pb_data
COPY --from=pocketbase /usr/local/bin/pocketbase /usr/local/bin/pocketbase
COPY --chmod=0755 scripts/container-entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --from=app-files /app /app
USER 10001:10001
VOLUME /pb_data
EXPOSE 8090
# Podman runs the first check one interval after the start (it ignores Docker's
# --start-interval), and the Quadlet unit's Notify=healthy waits for it: 10 s,
# not the default 30 s, so a start or update does not block half a minute.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8090/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

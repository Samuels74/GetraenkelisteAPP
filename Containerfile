# Getränkeliste – multi-stage image build (Podman/Buildah, see Makefile).
#
#   frontend-build  npm ci + lint + typecheck + unit tests + build of the SPA
#   pocketbase      PocketBase binary, verified against the release checksums.txt
#   test            Playwright image with PocketBase, SPA, API + E2E tests (`make test`)
#   runtime         the app image (last stage = default target, `make build`)
#
# HEALTHCHECK requires the docker image format: podman build --format docker

ARG PB_VERSION=0.40.4
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
ARG TARGETARCH
WORKDIR /tmp/pocketbase
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=amd64 ;; \
      arm64) arch=arm64 ;; \
      arm) arch=armv7 ;; \
      ppc64le) arch=ppc64le ;; \
      s390x) arch=s390x ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    zip="pocketbase_${PB_VERSION}_linux_${arch}.zip"; \
    base="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}"; \
    wget -q -O "${zip}" "${base}/${zip}"; \
    wget -q -O checksums.txt "${base}/checksums.txt"; \
    expected="$(awk -v f="${zip}" '$2 == f {print $1}' checksums.txt)"; \
    [ -n "${expected}" ] || { echo "${zip} is not listed in checksums.txt" >&2; exit 1; }; \
    echo "${expected}  ${zip}" | sha256sum -c -; \
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
COPY backend/pb_migrations /app/pb_migrations
COPY backend/pb_hooks /app/pb_hooks
COPY --from=frontend-build /src/frontend/dist /app/pb_public
USER 10001:10001
VOLUME /pb_data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8090/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

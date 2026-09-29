# Getränkeliste – entry point for development, build, tests and operation.
# Plain Podman commands (no compose provider). See docs/ARCHITECTURE.md §7.
#
# Containers run on the Podman host; when `podman` is a remote client (dev
# container) no bind mounts are used – data lives in a named volume and test
# reports are copied out with `podman cp`.

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

PODMAN         ?= podman
IMAGE          ?= localhost/getraenkeliste:latest
TEST_IMAGE     ?= localhost/getraenkeliste-test:latest
CONTAINER      ?= getraenkeliste
TEST_CONTAINER ?= getraenkeliste-test
VOLUME         ?= getraenkeliste-data
PORT           ?= 8090
PB_PORT        ?= 8090
VITE_PORT      ?= 5173
PB_VERSION     ?= 0.40.4

# All images/layers built here carry this label; only dangling images with it
# are pruned (never other images on the host).
PROJECT_LABEL  := io.getraenkeliste.project=getraenkeliste
# The results of the expensive intermediate stages are tagged, so the prune
# after each build removes stale layers but keeps the current build cache.
CACHE_IMAGE    ?= localhost/getraenkeliste-cache
# docker format: OCI images cannot carry the HEALTHCHECK
BUILD_FLAGS    ?= --format docker --layers --build-arg PB_VERSION=$(PB_VERSION)

build_stage  = $(PODMAN) build $(BUILD_FLAGS) --target $(1) -t $(2) -f Containerfile .
prune_images = $(PODMAN) image prune -f --filter label=$(PROJECT_LABEL) >/dev/null

.PHONY: help dev build test test-api run stop logs clean clean-data

help: ## show the available targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  make %-11s %s\n", $$1, $$2}'

dev: ## PocketBase (PB_PORT=8090) + Vite dev server (VITE_PORT=5173), no containers
	PB_PORT=$(PB_PORT) VITE_PORT=$(VITE_PORT) scripts/dev.sh

build: ## build the app image (frontend lint/typecheck/tests/build run inside)
	$(call build_stage,frontend-build,$(CACHE_IMAGE):frontend-build)
	$(call build_stage,pocketbase,$(CACHE_IMAGE):pocketbase)
	$(call build_stage,runtime,$(IMAGE))
	@$(prune_images)

test: ## API + E2E tests inside the test image (E2E_WORKERS=n); reports -> ./test-results
	$(call build_stage,frontend-build,$(CACHE_IMAGE):frontend-build)
	$(call build_stage,pocketbase,$(CACHE_IMAGE):pocketbase)
	$(call build_stage,test,$(TEST_IMAGE))
	@$(prune_images)
	@$(PODMAN) rm -f $(TEST_CONTAINER) >/dev/null 2>&1 || true
	@rc=0; \
	$(PODMAN) run --name $(TEST_CONTAINER) --init --shm-size=1g \
		$(if $(E2E_WORKERS),-e E2E_WORKERS) \
		$(TEST_IMAGE) || rc=$$?; \
	rm -rf test-results && mkdir -p test-results; \
	$(PODMAN) cp $(TEST_CONTAINER):/app/test-results/. test-results/ || echo "warning: could not copy the test reports" >&2; \
	$(PODMAN) rm -f $(TEST_CONTAINER) >/dev/null; \
	echo "test reports: ./test-results (exit code $$rc)"; \
	exit $$rc

test-api: ## API tests locally without Podman (uses .pb/pocketbase)
	scripts/dev-pocketbase.sh --download-only
	cd backend/tests && { [ -d node_modules ] || npm ci; } && npm test

run: ## start the app container: port PORT=8090, volume getraenkeliste-data
	$(PODMAN) run -d --replace --name $(CONTAINER) \
		--restart=unless-stopped \
		-p $(PORT):8090 \
		-v $(VOLUME):/pb_data \
		$(if $(PB_SUPERUSER_EMAIL),-e PB_SUPERUSER_EMAIL -e PB_SUPERUSER_PASSWORD) \
		$(if $(PB_ENCRYPTION_KEY),-e PB_ENCRYPTION_KEY) \
		$(IMAGE)
	@CONTAINER=$(CONTAINER) scripts/wait-for-app.sh $(PORT)

stop: ## stop and remove the app container (the data volume is kept)
	@$(PODMAN) stop --ignore $(CONTAINER) >/dev/null
	@$(PODMAN) rm -f --ignore $(CONTAINER) >/dev/null
	@echo "stopped $(CONTAINER) (data volume $(VOLUME) kept)"

logs: ## follow the app container logs
	$(PODMAN) logs -f $(CONTAINER)

clean: ## remove this project's containers and images (NOT the data volume)
	@$(PODMAN) rm -f --ignore $(CONTAINER) $(TEST_CONTAINER) >/dev/null
	@$(PODMAN) rmi -f --ignore $(IMAGE) $(TEST_IMAGE) \
		$(CACHE_IMAGE):frontend-build $(CACHE_IMAGE):pocketbase >/dev/null
	@$(prune_images)
	rm -rf test-results

clean-data: ## DELETE the data volume (all bookings!) – asks unless CONFIRM=yes
	@if [ "$(CONFIRM)" != "yes" ]; then \
		read -r -p "Delete volume $(VOLUME) with ALL data? Type 'yes': " answer; \
		[ "$$answer" = "yes" ] || { echo "aborted"; exit 1; }; \
	fi
	@$(PODMAN) rm -f --ignore $(CONTAINER) >/dev/null
	$(PODMAN) volume rm --force $(VOLUME)

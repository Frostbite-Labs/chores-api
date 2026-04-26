#!/usr/bin/env bash
#
# Build the Chore Club API into a deployable Docker image.
#
# Usage:
#   ./scripts/build.sh                  # tags <repo>:<git-sha> and <repo>:latest
#   ./scripts/build.sh v1.2.3           # also tags <repo>:v1.2.3
#   IMAGE_REPOSITORY=ghcr.io/foo/api ./scripts/build.sh v1.2.3
#   PUSH=1 ./scripts/build.sh v1.2.3    # push all tags after a successful build
#   PLATFORMS=linux/amd64,linux/arm64 PUSH=1 ./scripts/build.sh v1.2.3
#                                       # multi-arch via buildx (requires --push)
#
# Environment overrides:
#   IMAGE_REPOSITORY  Image repo to tag (default: chore-club-api).
#   PUSH              Set to 1 to push tags after building.
#   PLATFORMS         Comma-separated platform list. When set, uses `docker
#                     buildx` and forces PUSH=1 (buildx cannot --load multi-arch).

set -euo pipefail

REPO="${IMAGE_REPOSITORY:-chore-club-api}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$ROOT_DIR/api"

if [[ ! -f "$API_DIR/Dockerfile" ]]; then
  echo "error: $API_DIR/Dockerfile not found" >&2
  exit 1
fi

GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "nogit")"
GIT_DIRTY=""
if ! git -C "$ROOT_DIR" diff --quiet HEAD -- 2>/dev/null; then
  GIT_DIRTY="-dirty"
fi
SHA_TAG="${GIT_SHA}${GIT_DIRTY}"

EXTRA_TAG="${1:-}"

TAG_ARGS=( -t "$REPO:$SHA_TAG" -t "$REPO:latest" )
if [[ -n "$EXTRA_TAG" ]]; then
  TAG_ARGS+=( -t "$REPO:$EXTRA_TAG" )
fi

LABEL_ARGS=(
  --label "org.opencontainers.image.source=$(git -C "$ROOT_DIR" config --get remote.origin.url 2>/dev/null || echo unknown)"
  --label "org.opencontainers.image.revision=$GIT_SHA"
  --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
)

if [[ -n "${PLATFORMS:-}" ]]; then
  echo "==> buildx build $REPO ($PLATFORMS) from $API_DIR"
  docker buildx build \
    --platform "$PLATFORMS" \
    "${TAG_ARGS[@]}" \
    "${LABEL_ARGS[@]}" \
    --push \
    "$API_DIR"
else
  echo "==> docker build $REPO from $API_DIR"
  docker build \
    "${TAG_ARGS[@]}" \
    "${LABEL_ARGS[@]}" \
    "$API_DIR"

  if [[ "${PUSH:-0}" == "1" ]]; then
    echo "==> pushing tags"
    docker push "$REPO:$SHA_TAG"
    docker push "$REPO:latest"
    [[ -n "$EXTRA_TAG" ]] && docker push "$REPO:$EXTRA_TAG"
  fi
fi

echo "==> built tags:"
echo "    $REPO:$SHA_TAG"
echo "    $REPO:latest"
[[ -n "$EXTRA_TAG" ]] && echo "    $REPO:$EXTRA_TAG"

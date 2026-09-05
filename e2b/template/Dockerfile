ARG BASE_IMAGE=ghcr.io/tencentcloud/cubesandbox-base@sha256:a1dd972a4eef85448f967daed3bda42c6be2b7f42bf64c1f4d38e63b3e935472
ARG NODE_IMAGE=node:22-bullseye-slim@sha256:5736e7ef1f3f2109be7ef8aea0cbdf931804aee9a18c6760507b8ded078b25a9
FROM ${NODE_IMAGE} AS node
FROM ${BASE_IMAGE}

# Keep CubeSandbox's envd, entrypoint, and user 1000. Bullseye's Node binary
# supports the Ubuntu 22.04 base's glibc; copying Alpine's binary would not.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

ARG CODEX_REVISION
ARG CODEX_BINARY_SHA256
ARG CODEX_CODE_MODE_HOST_SHA256

COPY .build/codex /usr/local/bin/codex
COPY .build/codex-code-mode-host /usr/local/bin/codex-code-mode-host
COPY .build/build.json /etc/cudex/codex-build.json

RUN echo "${CODEX_BINARY_SHA256}  /usr/local/bin/codex" | sha256sum -c - \
    && echo "${CODEX_CODE_MODE_HOST_SHA256}  /usr/local/bin/codex-code-mode-host" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/codex /usr/local/bin/codex-code-mode-host \
    && mkdir -p /workspace /run/cudex \
    && chown 1000:1000 /workspace /run/cudex \
    && /usr/local/bin/codex --version \
    && git --version \
    && node --version \
    && npm --version \
    && /usr/local/bin/codex exec-server --help >/dev/null \
    && /usr/local/bin/codex-code-mode-host --help >/dev/null

LABEL io.cudex.codex-revision="${CODEX_REVISION}"
LABEL io.cudex.codex-sha256="${CODEX_BINARY_SHA256}"
LABEL io.cudex.codex-code-mode-host-sha256="${CODEX_CODE_MODE_HOST_SHA256}"

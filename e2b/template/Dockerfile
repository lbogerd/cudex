ARG BASE_IMAGE=cubesandbox-codex:0.1.0
FROM ${BASE_IMAGE}

ARG CODEX_REVISION
ARG CODEX_BINARY_SHA256
ARG CODEX_CODE_MODE_HOST_SHA256

COPY .build/codex /usr/local/bin/codex
COPY .build/codex-code-mode-host /usr/local/bin/codex-code-mode-host
COPY .build/build.json /etc/cudex/codex-build.json

RUN echo "${CODEX_BINARY_SHA256}  /usr/local/bin/codex" | sha256sum -c - \
    && echo "${CODEX_CODE_MODE_HOST_SHA256}  /usr/local/bin/codex-code-mode-host" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/codex /usr/local/bin/codex-code-mode-host \
    && mkdir -p /run/cudex \
    && chown 1000:1000 /workspace /run/cudex \
    && /usr/local/bin/codex --version \
    && /usr/local/bin/codex exec-server --help >/dev/null \
    && /usr/local/bin/codex-code-mode-host --help >/dev/null

LABEL io.cudex.codex-revision="${CODEX_REVISION}"
LABEL io.cudex.codex-sha256="${CODEX_BINARY_SHA256}"
LABEL io.cudex.codex-code-mode-host-sha256="${CODEX_CODE_MODE_HOST_SHA256}"

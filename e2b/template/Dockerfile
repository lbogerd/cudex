ARG BASE_IMAGE=cubesandbox-codex:0.1.0
FROM ${BASE_IMAGE}

ARG CODEX_REVISION
ARG CODEX_BINARY_SHA256

COPY .build/codex /usr/local/bin/codex
COPY .build/build.json /etc/cudex/codex-build.json

RUN echo "${CODEX_BINARY_SHA256}  /usr/local/bin/codex" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/codex \
    && chown 1000:1000 /workspace \
    && /usr/local/bin/codex --version \
    && /usr/local/bin/codex exec-server --help >/dev/null

LABEL io.cudex.codex-revision="${CODEX_REVISION}"
LABEL io.cudex.codex-sha256="${CODEX_BINARY_SHA256}"

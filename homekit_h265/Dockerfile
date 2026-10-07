# syntax=docker/dockerfile:1
# Official Node.js multi-architecture index, verified 2026-10-07.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

FROM ${NODE_IMAGE} AS build
WORKDIR /opt/homekit-h265/bridge
COPY bridge/package.json bridge/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY bridge/tsconfig.json ./
COPY bridge/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS relay
ARG TARGETARCH
ARG BUILD_ARCH
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# SHA-256 values come from the official v1.9.14 GitHub release asset digests.
# BUILD_ARCH supports Supervisor builds; TARGETARCH supports Docker Buildx.
RUN set -eu; \
    arch="${TARGETARCH:-${BUILD_ARCH:-$(dpkg --print-architecture)}}"; \
    case "$arch" in \
      amd64) asset=amd64; checksum=32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6 ;; \
      arm64|aarch64) asset=arm64; checksum=359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50 ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
      "https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_linux_${asset}" \
      --output /usr/local/bin/go2rtc; \
    printf '%s  %s\n' "$checksum" /usr/local/bin/go2rtc | sha256sum --check --strict; \
    chmod 0755 /usr/local/bin/go2rtc

FROM ${NODE_IMAGE}
ARG BUILD_VERSION=0.1.1
ARG BUILD_ARCH="aarch64|amd64"
LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="app" \
      io.hass.arch="${BUILD_ARCH}" \
      org.opencontainers.image.title="HomeKit H.265" \
      org.opencontainers.image.description="Native HEVC camera bridge for Apple Home" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.source="https://github.com/rmainmtus/homekit-h265"
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/homekit-h265
COPY --from=build /opt/homekit-h265/bridge/dist ./bridge/dist
COPY --from=build /opt/homekit-h265/bridge/node_modules ./bridge/node_modules
COPY --from=build /opt/homekit-h265/bridge/package.json ./bridge/package.json
COPY --from=relay /usr/local/bin/go2rtc /usr/local/bin/go2rtc
COPY LICENSE ./LICENSE
COPY bridge/THIRD-PARTY-LICENSE.txt ./THIRD-PARTY-LICENSE.txt
COPY runtime ./runtime
COPY bridge/NOTICE ./NOTICE
COPY licenses ./licenses
STOPSIGNAL SIGTERM
CMD ["node", "/opt/homekit-h265/runtime/launcher.cjs"]

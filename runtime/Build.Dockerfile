FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git procps zstd && rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN npm install --prefix /opt/timds --ignore-scripts --omit=dev @dtconcepts/timds@0.1.464 && mkdir -p /workspace /work /dependencies && chown node:node /work /dependencies
COPY build-driver.mjs /opt/timds/build-driver.mjs
WORKDIR /workspace
CMD ["sleep", "infinity"]

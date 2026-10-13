FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# The service executes only this image-baked program; repository code is data.
# Publish this exact toolkit version before building the deployment image.
RUN npm install --prefix /usr/local/lib/timds-repository --ignore-scripts --omit=dev @dtconcepts/timds@0.1.464
COPY repository-daemon.mjs repository-engine.mjs /usr/local/lib/timds-repository/
EXPOSE 8081
WORKDIR /workspace
CMD ["sleep", "infinity"]

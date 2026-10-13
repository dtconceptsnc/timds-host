FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts @openai/codex@0.156.1
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY agent.mjs /usr/local/lib/timds-agent.mjs
COPY policy.mjs /usr/local/lib/policy.mjs
COPY live-dev.mjs /usr/local/lib/timds-live-dev.mjs
EXPOSE 8080
WORKDIR /workspace
CMD ["sleep", "infinity"]

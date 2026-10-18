# Spike S5 image: the harness's base image and tmux, plus Pi 1.3.0 installed exactly in /spike.
# Build context: spikes/s5-tui-branding. Run with --network none (no model calls are possible).
ARG NODE_IMAGE=node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends tmux=3.5a-3 && rm -rf /var/lib/apt/lists/*
WORKDIR /spike
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force && ./node_modules/.bin/pi --version
COPY extension ./extension
COPY themes ./themes
COPY prompts ./prompts
COPY agent ./agent
COPY tmux.conf run-s5.sh ./
RUN chmod 0755 run-s5.sh && mkdir -p /spike/out && chown node:node /spike/out
USER node
CMD ["/spike/run-s5.sh"]

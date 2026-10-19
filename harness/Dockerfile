# Gaffer harness ("brain"): Pi 1.3.0 + the pi-gaffer package, served in the browser by ttyd → tmux (the Gaffer
# Terminal) and by gaffer-web (the Gaffer App).
# Build context: repository root.
ARG NODE_IMAGE=node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe

# ttyd 1.7.7 static binary (not packaged in Debian trixie), checksum-verified, plus its page with a viewport tag
# (spike S9: phones laid it out at 980 px) and our script (Shift+Enter, OSC 52 copy, title).
FROM ${NODE_IMAGE} AS ttyd
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64;  sum=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55 ;; \
      arm64) arch=aarch64; sum=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165 ;; \
      *) echo "unsupported arch $TARGETARCH"; exit 1 ;; \
    esac; \
    mkdir /out; \
    curl -fsSL -o /out/ttyd "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.$arch"; \
    echo "$sum  /out/ttyd" | sha256sum -c -; \
    chmod 0755 /out/ttyd
COPY harness/ttyd-keys.js /tmp/ttyd-keys.js
RUN set -eu; \
    /out/ttyd --port 7999 true & pid=$!; \
    for i in 1 2 3 4 5 6 7 8 9 10; do curl -fs http://127.0.0.1:7999/ -o /tmp/index.html && break; sleep 0.5; done; \
    kill $pid; \
    node -e 'const fs=require("fs"); const h=fs.readFileSync("/tmp/index.html","utf8"); const js=fs.readFileSync("/tmp/ttyd-keys.js","utf8"); if(!h.includes("window.term=") || !h.includes("</head>")) throw new Error("ttyd page changed: no window.term or </head>"); fs.writeFileSync("/out/ttyd-index.html", h.replace("</head>", "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head>").replace("</body>", "<script>"+js+"</script></body>"));'

FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends tmux=3.5a-3 && rm -rf /var/lib/apt/lists/*
COPY --from=ttyd /out/ttyd /usr/local/bin/ttyd
# Pi and its whole dependency tree from a committed lockfile (NFR-MNT-01, ADR 0009): since 1.0.1 Pi ships no
# npm-shrinkwrap.json, so `npm install -g` would resolve the transitive dependencies afresh on every build.
COPY harness/pi/package.json harness/pi/package-lock.json /opt/pi/
RUN cd /opt/pi && npm ci --no-audit --no-fund && npm cache clean --force \
 && ln -s /opt/pi/node_modules/.bin/pi /usr/local/bin/pi

ENV PI_CODING_AGENT_DIR=/opt/pi-agent \
    PI_TELEMETRY=0 \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    GAFFER_DATA_DIR=/data \
    GAFFER_SESSIONS_ROOT=/sessions \
    GAFFER_ID_SALT_FILE=/run/secrets/gaffer_id_salt \
    SANDBOX_PROVIDER=compose \
    SANDBOX_URL=http://sandbox:8080 \
    TERM=xterm-256color \
    COLORTERM=truecolor \
    LANG=C.UTF-8

# The Pi package: extensions, shared src, skills, prompt templates and theme. Pi supplies its own
# packages and typebox to extensions. scripts/ holds operator tools run with plain node (replay.ts).
COPY packages/pi-gaffer/package.json /opt/pi-gaffer/package.json
COPY packages/pi-gaffer/extensions /opt/pi-gaffer/extensions
COPY packages/pi-gaffer/src /opt/pi-gaffer/src
COPY packages/pi-gaffer/skills /opt/pi-gaffer/skills
COPY packages/pi-gaffer/prompts /opt/pi-gaffer/prompts
COPY packages/pi-gaffer/scripts /opt/pi-gaffer/scripts
COPY packages/pi-gaffer/themes /opt/pi-gaffer/themes
# Operator tools (gaffer admin, gaffer-eval) and the eval runner, run with plain node. They import the
# package's src/ by the repository's relative path (../../packages/pi-gaffer/src), so /opt/packages/pi-gaffer
# points at the installed package; /opt/node_modules exposes the Pi packages they import.
COPY tools/package.json /opt/tools/package.json
COPY tools/gaffer-admin /opt/tools/gaffer-admin
COPY tools/gaffer-eval /opt/tools/gaffer-eval
COPY evals/package.json /opt/evals/package.json
COPY evals/runner /opt/evals/runner
RUN set -eu; P=/opt/pi/node_modules; \
    mkdir -p /opt/packages /opt/node_modules/@earendil-works; \
    ln -s /opt/pi-gaffer /opt/packages/pi-gaffer; \
    ln -s "$P/@earendil-works/pi-coding-agent" /opt/node_modules/@earendil-works/pi-coding-agent; \
    ln -s "$P/@earendil-works/pi-ai" /opt/node_modules/@earendil-works/pi-ai; \
    ln -s "$P/@earendil-works/pi-tui" /opt/node_modules/@earendil-works/pi-tui; \
    ln -s "$P/typebox" /opt/node_modules/typebox
# The Gaffer App's bridge and page (ADR 0014): plain Node, Pi's RpcClient from /opt/node_modules, and Gaffer's
# src/ through /opt/packages/pi-gaffer; the page is static files (Preact and htm vendored, fonts self-hosted).
COPY packages/gaffer-web/server.ts /opt/packages/gaffer-web/server.ts
COPY packages/gaffer-web/src /opt/packages/gaffer-web/src
COPY packages/gaffer-web/public /opt/packages/gaffer-web/public
COPY --from=ttyd /out/ttyd-index.html /opt/gaffer/ttyd-index.html
COPY harness/tmux.conf harness/gaffer-pi harness/entrypoint.sh harness/egress-ip.mjs harness/settings.json /opt/gaffer/
# The brand tokens: the entrypoint passes their xterm.js palette to ttyd.
COPY docs/ui/brand/tokens.json /opt/gaffer/tokens.json
# Keys that reach model and thinking changes, the external editor, suspend, the session tree, fork, and
# session delete and rename in the /resume selector, unbound (ADR 0013).
COPY --chown=10002:10002 harness/keybindings.json /opt/pi-agent/keybindings.json

# Pi runs with cwd /work, the sandbox's working dir: Pi resolves tool paths and command cwds against the
# session cwd, so the two must match. Here /work is empty and root-owned: no project resources, no context files.
RUN useradd --uid 10002 --create-home --home-dir /home/gaffer --shell /usr/sbin/nologin gaffer \
 && mkdir -p /work /sessions /data /opt/pi-agent \
 && chown -R gaffer:gaffer /home/gaffer /sessions /data /opt/pi-agent

USER gaffer
# Install the package globally for this agent dir, then add harness/settings.json: the Gaffer theme pair and
# Gaffer's own start-up header (quietStartup, ADR 0013); Pi's
# built-in MCP, codemode, tool search and llama.cpp unloaded (ADR 0012, with --no-mcp in gaffer-pi); /share
# can only target a gist (the image has no gh), no external editor, no /skill:* commands, and Esc Esc does
# nothing (ADR 0013).
RUN pi install /opt/pi-gaffer \
 && node -e 'const f="/opt/pi-agent/settings.json"; const fs=require("fs"); const s=JSON.parse(fs.readFileSync(f,"utf8")); Object.assign(s, JSON.parse(fs.readFileSync("/opt/gaffer/settings.json","utf8"))); fs.writeFileSync(f, JSON.stringify(s,null,2));' \
 && cat /opt/pi-agent/settings.json

WORKDIR /work
EXPOSE 7681 7682
ENTRYPOINT ["/opt/gaffer/entrypoint.sh"]

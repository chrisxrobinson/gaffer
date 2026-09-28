# Gaffer harness ("brain"): Pi 0.87.1 + the pi-gaffer package, served in the browser by ttyd → tmux.
# Build context: repository root.
ARG NODE_IMAGE=node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe

# ttyd 1.7.7 static binary (not packaged in Debian trixie), checksum-verified, plus its page with our key handler.
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
    node -e 'const fs=require("fs"); const h=fs.readFileSync("/tmp/index.html","utf8"); const js=fs.readFileSync("/tmp/ttyd-keys.js","utf8"); if(!h.includes("window.term=")) throw new Error("ttyd page no longer exposes window.term"); fs.writeFileSync("/out/ttyd-index.html", h.replace("</body>", "<script>"+js+"</script></body>"));'

FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends tmux=3.5a-3 && rm -rf /var/lib/apt/lists/*
COPY --from=ttyd /out/ttyd /usr/local/bin/ttyd
RUN npm install -g @earendil-works/pi-coding-agent@0.87.1 && npm cache clean --force

ENV PI_CODING_AGENT_DIR=/opt/pi-agent \
    PI_TELEMETRY=0 \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    GAFFER_DATA_DIR=/data \
    GAFFER_ID_SALT_FILE=/run/secrets/gaffer_id_salt \
    SANDBOX_PROVIDER=compose \
    SANDBOX_URL=http://sandbox:8080 \
    TERM=xterm-256color \
    COLORTERM=truecolor \
    LANG=C.UTF-8

# The Pi package: extensions, shared src and theme. Pi supplies its own packages and typebox to extensions.
COPY packages/pi-gaffer/package.json /opt/pi-gaffer/package.json
COPY packages/pi-gaffer/extensions /opt/pi-gaffer/extensions
COPY packages/pi-gaffer/src /opt/pi-gaffer/src
COPY packages/pi-gaffer/themes /opt/pi-gaffer/themes
COPY --from=ttyd /out/ttyd-index.html /opt/gaffer/ttyd-index.html
COPY harness/tmux.conf harness/gaffer-pi harness/entrypoint.sh harness/egress-ip.mjs /opt/gaffer/

# Pi runs with cwd /work, the sandbox's working dir: Pi resolves tool paths and command cwds against the
# session cwd, so the two must match. Here /work is empty and root-owned: no project resources, no context files.
RUN useradd --uid 10002 --create-home --home-dir /home/gaffer --shell /usr/sbin/nologin gaffer \
 && mkdir -p /work /sessions /data /opt/pi-agent \
 && chown -R gaffer:gaffer /home/gaffer /sessions /data /opt/pi-agent

USER gaffer
# Install the package globally for this agent dir, and select the Gaffer theme.
RUN pi install /opt/pi-gaffer \
 && node -e 'const f="/opt/pi-agent/settings.json"; const fs=require("fs"); const s=JSON.parse(fs.readFileSync(f,"utf8")); s.theme="gaffer"; fs.writeFileSync(f, JSON.stringify(s,null,2));' \
 && cat /opt/pi-agent/settings.json

WORKDIR /work
EXPOSE 7681
ENTRYPOINT ["/opt/gaffer/entrypoint.sh"]

# Spike S9 image: the S5 image (Pi 1.3.0 + tmux 3.5a + the branding extension) plus ttyd 1.7.7,
# fetched and checksum-verified exactly like harness/Dockerfile, with the harness's Shift+Enter handler.
# Build context: spikes/s9-web-terminal. Requires gaffer-spike-s5:latest (build S5 first).
ARG NODE_IMAGE=node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
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
COPY ttyd-keys.js /tmp/ttyd-keys.js
RUN set -eu; \
    /out/ttyd --port 7999 true & pid=$!; \
    for i in 1 2 3 4 5 6 7 8 9 10; do curl -fs http://127.0.0.1:7999/ -o /tmp/index.html && break; sleep 0.5; done; \
    kill $pid; cp /tmp/index.html /out/ttyd-index.orig.html; \
    node -e 'const fs=require("fs"); const h=fs.readFileSync("/tmp/index.html","utf8"); const js=fs.readFileSync("/tmp/ttyd-keys.js","utf8"); if(!h.includes("window.term=")) throw new Error("no window.term"); fs.writeFileSync("/out/ttyd-index.html", h.replace("</body>", "<script>"+js+"</script></body>"));'

FROM gaffer-spike-s5:latest
COPY --from=ttyd /out/ttyd /usr/local/bin/ttyd
COPY --from=ttyd /out/ttyd-index.html /out/ttyd-index.orig.html /spike/s9/
COPY tmux.conf run-pi.sh /spike/s9/
COPY fill-extension.ts /spike/s9/fill-extension.ts
USER root
RUN chmod 0755 /spike/s9/run-pi.sh
USER node
EXPOSE 27681
# Same flags as harness/entrypoint.sh except: plain 0.0.0.0 inside the container (published on host 127.0.0.1 only),
# port 27681, and no titleFixed (so the tab title test can see Pi's title through tmux).
CMD ["ttyd", "--port", "27681", "--writable", "--max-clients", "1", "--index", "/spike/s9/ttyd-index.html", \
     "-t", "fontSize=15", "-t", "disableLeaveAlert=true", "-t", "scrollback=10000", \
     "-t", "theme={\"background\":\"#121a15\",\"foreground\":\"#e8e8e3\"}", \
     "tmux", "-f", "/spike/s9/tmux.conf", "new-session", "-A", "-s", "s9", "/spike/s9/run-pi.sh"]

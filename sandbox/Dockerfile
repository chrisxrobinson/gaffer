# Gaffer sandbox ("hands", ADR 0001): no network, no secrets, non-root, read-only root.
# Build context: repository root.
FROM python:3.14-slim@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d

# Pinned analytics stack. open-fpl-solver (pinned commit) joins in ROADMAP M3 with gaffer_lib.plan.
RUN pip install --no-cache-dir \
      numpy==2.5.3 \
      pandas==3.0.6 \
      scipy==1.18.1 \
      highspy==1.15.1 \
      pydantic==2.13.5

COPY python/gaffer_lib /tmp/gaffer_lib
RUN pip install --no-cache-dir /tmp/gaffer_lib \
 && rm -rf /tmp/gaffer_lib \
 # No pip at runtime: missing libraries mean a new image, deliberately.
 && pip uninstall -y pip \
 && useradd --uid 10001 --no-create-home --home-dir /work --shell /usr/sbin/nologin sandbox \
 && mkdir -p /work /data && chown sandbox:sandbox /work

COPY sandbox/sandboxd.py /opt/sandboxd/sandboxd.py

USER 10001:10001
WORKDIR /work
EXPOSE 8080
# env -i: sandboxd starts from an empty environment (the base image sets PYTHON_* and friends),
# and it builds a fixed minimal env for every command it runs.
ENTRYPOINT ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/work", "/usr/local/bin/python", "/opt/sandboxd/sandboxd.py", "--port", "8080", "--work", "/work"]

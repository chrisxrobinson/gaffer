# Gaffer sandbox ("hands", ADR 0001): no network, no secrets, non-root, read-only root.
# Build context: repository root.
FROM python:3.14-slim@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d

# Pinned analytics stack. requests and fuzzywuzzy (with requests' own dependencies) are only there
# because open-fpl-solver imports them at module load; the sandbox has no network to use them on.
RUN pip install --no-cache-dir \
      numpy==2.5.3 \
      pandas==3.0.6 \
      scipy==1.18.1 \
      highspy==1.15.1 \
      pydantic==2.13.5 \
      requests==2.34.2 \
      certifi==2026.7.22 \
      charset-normalizer==3.5.2 \
      idna==3.20 \
      urllib3==2.8.0 \
      fuzzywuzzy==0.18.0

# open-fpl-solver (Apache-2.0) at a pinned commit, verified by checksum. It isn't an installable
# package (its wheel leaves out utils.py and paths.py), so the source tree is vendored and
# gaffer_lib.plan imports it from /opt/open-fpl-solver. Its `run/` scripts and `data/` are not used:
# gaffer_lib builds the solver's input itself, because the solver's own loader calls the FPL API.
ARG OPEN_FPL_SOLVER_COMMIT=ec65f5e2b2be34441cb4b2a9efafea1ec0fe3b79
ADD --checksum=sha256:16c43ea32d66ca6f2d75edfd294327ade5c92069c7b50bad60820edf5e353e6d \
    https://github.com/solioanalytics/open-fpl-solver/archive/${OPEN_FPL_SOLVER_COMMIT}.tar.gz /tmp/open-fpl-solver.tar.gz
RUN mkdir -p /opt/open-fpl-solver \
 && tar -xzf /tmp/open-fpl-solver.tar.gz -C /opt/open-fpl-solver --strip-components=1 \
      "open-fpl-solver-${OPEN_FPL_SOLVER_COMMIT}/dev/solver.py" \
      "open-fpl-solver-${OPEN_FPL_SOLVER_COMMIT}/dev/data_parser.py" \
      "open-fpl-solver-${OPEN_FPL_SOLVER_COMMIT}/utils.py" \
      "open-fpl-solver-${OPEN_FPL_SOLVER_COMMIT}/paths.py" \
      "open-fpl-solver-${OPEN_FPL_SOLVER_COMMIT}/LICENSE" \
      "open-fpl-solver-${OPEN_FPL_SOLVER_COMMIT}/README.md" \
 && echo "${OPEN_FPL_SOLVER_COMMIT}" > /opt/open-fpl-solver/COMMIT \
 && rm /tmp/open-fpl-solver.tar.gz \
 # The root filesystem is read-only at run time, so compile the bytecode now.
 && python -m compileall -q /opt/open-fpl-solver

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

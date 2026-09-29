# Seccomp profile

`moby-default-v27.3.1.json` is Docker's default seccomp profile, copied unmodified from
`https://raw.githubusercontent.com/moby/moby/v27.3.1/profiles/seccomp/default.json`
(sha256 `9c1025c88ccaa517b648da571961838744ea2137f176bfe6a48b21294cae9c76`, fetched 2026-09-28).

Compose sets it explicitly on the sandbox (`security_opt: seccomp=…`) because a Docker daemon can be
configured to run containers unconfined by default: the Docker Desktop used to build M1 reports
`name=seccomp,profile=unconfined` in `docker info`, and the sandbox had `Seccomp: 0` until this was set.

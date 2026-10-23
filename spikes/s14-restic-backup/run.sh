#!/bin/sh
# S14: back up a copy of Gaffer's volumes and secrets with restic, restore into fresh volumes, compare.
# Source: M1.1-4's test volumes (gaffer-m114_*), never the live ones. Repository: a local volume standing in for
# offsite storage (a Storage Box or R2 is the same restic command with another repository URL).
set -eu
IMG=restic/restic:0.19.1
export RESTIC_PASSWORD="s14-throwaway-$(date +%s)"
docker volume create s14-repo >/dev/null
docker volume create s14-restore-sessions >/dev/null
docker volume create s14-restore-data >/dev/null
docker volume create s14-secrets >/dev/null
SECRETS="$(pwd)/.secrets-throwaway"; mkdir -p "$SECRETS"; printf 'sk-test-not-a-key' > "$SECRETS/anthropic_api_key"; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRETS/gaffer_id_salt"
# Docker Desktop's file sharing gives restic EIO on bind-mounted files (it opens with O_NOATIME), so the
# secrets are staged in a volume, as they would sit on a Linux host's own disk.
docker run --rm -v "$SECRETS":/in:ro -v s14-secrets:/out alpine:3.24 cp /in/anthropic_api_key /in/gaffer_id_salt /out/
R="docker run --rm -e RESTIC_PASSWORD -e RESTIC_REPOSITORY=/repo -v s14-repo:/repo"
$R $IMG init
$R -v gaffer-m114_sessions:/src/sessions:ro -v gaffer-m114_data:/src/data:ro -v s14-secrets:/src/secrets:ro $IMG backup --host gaffer /src
$R $IMG snapshots --compact
$R -v s14-restore-sessions:/dst/src/sessions -v s14-restore-data:/dst/src/data $IMG restore latest --target /dst --include /src/sessions --include /src/data
docker volume create s14-restore-secrets >/dev/null
$R -v s14-restore-secrets:/dst/src/secrets $IMG restore latest --target /dst --include /src/secrets >/dev/null
echo "--- compare (sha256 of every file, sorted)"
sum() { docker run --rm -v "$1":/v:ro alpine:3.24 sh -c 'cd /v && find . -type f | sort | xargs sha256sum | sha256sum'; }
echo "sessions: $(sum gaffer-m114_sessions) vs $(sum s14-restore-sessions)"
echo "data:     $(sum gaffer-m114_data) vs $(sum s14-restore-data)"
echo "secrets:  $(sum s14-secrets) vs $(sum s14-restore-secrets)"
echo "files:    $(docker run --rm -v gaffer-m114_sessions:/v:ro alpine:3.24 sh -c 'find /v -type f | wc -l') sessions files"
echo "--- wrong password"
RESTIC_PASSWORD=wrong $R $IMG snapshots 2>&1 | tail -1
echo "--- what the storage holds (no names or contents)"
docker run --rm -v s14-repo:/repo:ro alpine:3.24 sh -c 'ls /repo; echo "files containing \"sessions\": $(grep -rl sessions /repo | wc -l)"; echo "files containing \"gaffer.recommendation\": $(grep -rl gaffer.recommendation /repo | wc -l)"'
docker run --rm -v s14-repo:/repo:ro alpine:3.24 du -sh /repo
rm -rf "$SECRETS"

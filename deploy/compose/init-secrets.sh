#!/bin/sh
# Create the Compose secret files (gitignored). The ID salt is random; paste your LLM key into anthropic_api_key.
set -eu
cd "$(dirname "$0")"
mkdir -p secrets
chmod 700 secrets
# Files are 0644 inside a 0700 directory: Compose bind-mounts each file with its host mode, and the harness
# runs as uid 10002, which must be able to read them on Linux hosts. The directory keeps other host users out.
[ -s secrets/gaffer_id_salt ] || od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > secrets/gaffer_id_salt
[ -e secrets/anthropic_api_key ] || : > secrets/anthropic_api_key
chmod 644 secrets/gaffer_id_salt secrets/anthropic_api_key
[ -s secrets/anthropic_api_key ] || echo "Add your provider key to $(pwd)/secrets/anthropic_api_key (Gaffer starts without it, but can't call the model)."

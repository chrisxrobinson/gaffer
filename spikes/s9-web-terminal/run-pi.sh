#!/bin/sh
# Pi 1.3.0 as in harness/gaffer-pi, with the S5 branding extension and a temp agent dir. No API key: no model calls.
set -eu
export PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 COLORTERM=truecolor LANG=C.UTF-8
d=/tmp/pi-agent
if [ ! -d "$d" ]; then
	mkdir -p "$d" /tmp/work
	node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync("/spike/agent/settings.gaffer.json","utf8")); s.themes=["/spike/themes"]; s.prompts=["/spike/prompts"]; s.theme="gaffer-light/gaffer-dark"; fs.writeFileSync("/tmp/pi-agent/settings.json", JSON.stringify(s,null,2));'
	cp /spike/agent/keybindings.json "$d/"
fi
export PI_CODING_AGENT_DIR="$d" S5_LOG=/tmp/s9.log
cd /tmp/work
exec /spike/node_modules/.bin/pi --tui-mode fullscreen --no-context-files --session-dir /tmp/sessions --continue \
	-e /spike/extension/gaffer-brand.ts -e /spike/s9/fill-extension.ts

#!/bin/sh
# Spike S5 driver. Runs INSIDE the spike container (see README): starts the real Pi 1.3.0 CLI in a
# detached 100x40 tmux pane, types commands with send-keys, and captures the screen (ANSI + plain).
# No model calls: the container runs with --network none and only a fake key.
set -u
OUT=/spike/out
PI=/spike/node_modules/.bin/pi
CONF=/spike/tmux.conf
mkdir -p "$OUT"
export PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 TERM=xterm-256color COLORTERM=truecolor LANG=C.UTF-8
export ANTHROPIC_API_KEY=spike-fake-key-no-network

cap() { # cap <name>
	tmux capture-pane -e -p -t s5 >"$OUT/$1.ansi"
	tmux capture-pane -p -t s5 >"$OUT/$1.txt"
}

agent_dir() { # agent_dir <settings-variant> <theme-or-empty> -> fresh temp PI_CODING_AGENT_DIR
	d=$(mktemp -d /tmp/pi-agent.XXXXXX)
	cp /spike/agent/models.json "$d/models.json"
	node -e '
		const fs = require("fs");
		const [src, theme, out, kb] = process.argv.slice(1);
		const s = JSON.parse(fs.readFileSync(src, "utf8"));
		s.themes = ["/spike/themes"]; s.prompts = ["/spike/prompts"];
		if (theme) s.theme = theme; else delete s.theme;
		fs.writeFileSync(out + "/settings.json", JSON.stringify(s, null, 2));
	' "/spike/agent/settings.$1.json" "$2" "$d"
	[ "$1" = gaffer ] && cp /spike/agent/keybindings.json "$d/keybindings.json"
	echo "$d"
}

start() { # start <label> <settings-variant> <theme> <bg: dark|light> <with-extension: 1|0>
	tmux kill-session -t s5 2>/dev/null
	if [ "$4" = light ]; then tmux set -g window-style 'bg=#fafaf7,fg=#1c1c1c'; else tmux set -g window-style 'bg=#101410,fg=#e8e8e3'; fi
	ad=$(agent_dir "$2" "$3")
	ext=""; [ "$5" = 1 ] && ext="-e /spike/extension/gaffer-brand.ts"
	mkdir -p /tmp/work && cd /tmp/work
	tmux new-session -d -s s5 -x 100 -y 40 \
		"env PI_CODING_AGENT_DIR=$ad S5_LOG=$OUT/$1.log $PI --tui-mode fullscreen --no-context-files --session-dir /tmp/sessions-$1 $ext; echo PI-EXITED; sleep 30"
	sleep 4
	echo "== $1: title=[$(tmux display -p -t s5 '#{pane_title}')]" >>"$OUT/titles.txt"
}

typecmd() { # typecmd <label> <text>: type, capture autocomplete, Esc (close menu), Enter, capture, Esc
	n=$(echo "$2" | tr -c 'a-zA-Z0-9-' '_')
	tmux send-keys -t s5 -l "$2"; sleep 0.6; cap "$1-$n-typed"
	tmux send-keys -t s5 Escape; sleep 0.2
	tmux send-keys -t s5 Enter; sleep 1.5; cap "$1-$n-after"
	tmux send-keys -t s5 Escape; sleep 0.3
	tmux send-keys -t s5 C-u; sleep 0.2  # clear anything left in the editor (ctrl+u deletes to line start)
}

tmux -f "$CONF" new-session -d -s ctl "sleep 3600"

CMDS="/settings /model /thinking /scoped-models /export /import /share /bug /copy /name /session /changelog /hotkeys /fork /clone /tree /trust /login /logout /new /compact /resume /reload /debug /arminsayshi /dementedelves /mcp /llama"

# 1. Baseline: stock Pi 1.3.0, no Gaffer extension, default settings (system theme).
start baseline baseline "" dark 0
cap baseline-start
tmux send-keys -t s5 -l "/"; sleep 0.8; cap baseline-slash-menu
tmux send-keys -t s5 Escape C-u; sleep 0.3
for c in /share /bug /login /settings /model /export /tree; do typecmd baseline "$c"; done
tmux send-keys -t s5 C-l; sleep 1; cap baseline-key-ctrl-l; tmux send-keys -t s5 Escape; sleep 0.3
tmux send-keys -t s5 Escape; sleep 0.1; tmux send-keys -t s5 Escape; sleep 1; cap baseline-key-esc-esc; tmux send-keys -t s5 Escape; sleep 0.3

# 2. Gaffer-branded: extension + settings + keybindings, theme gaffer (dark terminal).
start gaffer gaffer gaffer dark 1
cap gaffer-start
sleep 2; cap gaffer-start-2s   # the countdown must have moved by ~2 s
tmux send-keys -t s5 -l "/"; sleep 0.8; cap gaffer-slash-menu
tmux send-keys -t s5 Escape C-u; sleep 0.3
for c in $CMDS; do typecmd gaffer "$c"; done
typecmd gaffer "/team 1234567"
typecmd gaffer "/model claude-opus"
typecmd gaffer "/skill:gaffer-workflow"
typecmd gaffer "@"
for k in C-l C-p BTab C-g C-z; do
	tmux send-keys -t s5 "$k"; sleep 1; cap "gaffer-key-$k"; tmux send-keys -t s5 Escape; sleep 0.3
done
tmux send-keys -t s5 Escape; sleep 0.1; tmux send-keys -t s5 Escape; sleep 1; cap gaffer-key-esc-esc
typecmd gaffer "/quit"   # blocked, so Pi must still be running afterwards
echo "== gaffer after /quit: title=[$(tmux display -p -t s5 '#{pane_title}')]" >>"$OUT/titles.txt"

# 3. Themes: unset (system default), gaffer, and a light/dark pair, on a dark and a light terminal.
for bg in dark light; do
	start "theme-system-$bg" gaffer "" "$bg" 1; cap "theme-system-$bg"
	start "theme-gaffer-$bg" gaffer gaffer "$bg" 1; cap "theme-gaffer-$bg"
	start "theme-pair-$bg" gaffer "gaffer-light/gaffer-dark" "$bg" 1; cap "theme-pair-$bg"
done

tmux kill-server
echo done

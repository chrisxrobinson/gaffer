// Injected into ttyd's page (harness/Dockerfile).
// - xterm.js sends plain "\r" for Shift+Enter, so Pi would submit instead of inserting a newline. Send the
//   CSI-u sequence instead (as Pi's docs recommend for VS Code); tmux passes it on.
// - Copy: ttyd 1.7.7 has no OSC 52 handler, so Pi's "Copied!" never reached the clipboard (spike S9).
//   Clipboard reads ("?") are ignored.
// - Title: ttyd keeps titleFixed (its own handler appends the command and host name); Pi's title is shown as is.
(function hook() {
	var t = window.term;
	if (!t || !t.attachCustomKeyEventHandler || !t.parser) return setTimeout(hook, 100);
	t.attachCustomKeyEventHandler(function (e) {
		if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
			if (e.type === "keydown") t.input("\x1b[13;2u", true);
			return false;
		}
		return true;
	});
	t.parser.registerOscHandler(52, function (data) {
		var b64 = data.slice(data.indexOf(";") + 1);
		if (b64 === "?") return true;
		try {
			var text = new TextDecoder().decode(Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); }));
			navigator.clipboard.writeText(text).catch(function (err) { console.warn("Gaffer: copy refused by the browser", err); });
		} catch (err) {
			console.warn("Gaffer: copy failed", err);
		}
		return true;
	});
	t.onTitleChange(function (title) { if (title) document.title = title; });
})();

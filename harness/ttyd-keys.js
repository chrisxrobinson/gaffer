// Injected into ttyd's page. xterm.js sends plain "\r" for Shift+Enter, so Pi would submit instead of
// inserting a newline. Send the CSI-u sequence instead (as Pi's docs recommend for VS Code); tmux passes it on.
(function hook() {
	var t = window.term;
	if (!t || !t.attachCustomKeyEventHandler) return setTimeout(hook, 100);
	t.attachCustomKeyEventHandler(function (e) {
		if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
			if (e.type === "keydown") t.input("\x1b[13;2u", true);
			return false;
		}
		return true;
	});
})();

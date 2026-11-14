# #351 Windows: expanding a reasoning row scrolls the chat list to its end

On Windows (WebView2), expanding a reasoning ("thinking") row in the chat scrolls the message list to its end. The packaged spec `chat-reasoning-rows` fails on it: the expanded header moved 1014 px against a 2 px limit.

Measured in a Windows 11 arm64 VM: before the toggle `scrollTop` was 0; between 16 and 50 ms after expanding, the list scrolled itself to the end. The scroller has `overflow-anchor: none`, so this is the timeline revealing the end, not browser scroll anchoring or a measuring error. The probe ran at a 1000x720 CSS viewport at device pixel ratio 2 against a 1280x760 request; a run at the requested viewport would tell WebView2 apart from the narrower viewport.

Fails the same way on `main` (found while validating #349). Not traced: which timeline path reveals the end.

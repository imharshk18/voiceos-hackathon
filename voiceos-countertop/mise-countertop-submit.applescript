-- Mise Countertop's local, hackathon-only VoiceOS refresher.
-- Called by mise-countertop-autorefresh.mjs after Convex reports a real state change.
-- It requires Accessibility permission for the Terminal app that launches the watcher.

on run argv
	if (count of argv) is not 2 then error "Expected VoiceOS app name and refresh prompt."
	set appName to item 1 of argv
	set refreshPrompt to item 2 of argv

	tell application "System Events"
		if not (exists process appName) then error appName & " is not running."
	end tell

	tell application appName to activate
	delay 0.55

	tell application "System Events"
		tell process appName
			set frontmost to true
			-- Agent Mode's composer is exposed as either a text field or text area.
			-- System Events cannot filter `entire contents` with a compound role
			-- predicate, so walk the accessibility tree and keep the last editable
			-- element instead. The composer is the last one in Agent Mode.
			set composer to missing value
			set allElements to entire contents of window 1
			repeat with anElement in allElements
				try
					set elementRole to role of anElement
					if elementRole is "AXTextField" or elementRole is "AXTextArea" then set composer to anElement
				end try
			end repeat
			if composer is not missing value then
				click composer
			else
				-- VoiceOS currently renders its Agent Mode composer inside a custom
				-- accessibility container on some macOS versions. It may not expose an
				-- AXTextField at all. The message box is nevertheless pinned to the
				-- lower edge of the active VoiceOS window, so use the live window frame
				-- rather than a hard-coded monitor coordinate as a last-resort target.
				set {windowX, windowY} to position of window 1
				set {windowWidth, windowHeight} to size of window 1
				set composerX to windowX + (windowWidth div 2)
				set composerY to windowY + windowHeight - 66
				click at {composerX, composerY}
			end if
			delay 0.12
			keystroke refreshPrompt
			delay 0.12
			key code 36 -- Return
		end tell
	end tell
end run

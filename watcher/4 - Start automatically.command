#!/bin/bash
# Optional. Adds a login item so the Watcher runs when you log in.
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
PLIST="$HOME/Library/LaunchAgents/com.pokemon.watcher.plist"

cat <<'NOTICE'

  ================================================================
   START AUTOMATICALLY WHEN YOU LOG IN
  ================================================================

  WHAT THIS DOES
    Adds one login item to your own account. macOS starts it when you
    log in, so the Watcher runs on its own instead of you
    double-clicking file 2 every time.

  WHY YOU MIGHT WANT IT
    Your app only updates while the Watcher is running. After a
    restart it is off until somebody notices. Restocks often land at
    three in the morning.

  WHAT IT DOES NOT DO
    - No administrator password. Nothing installed system-wide.
    - Nothing hidden: it is one readable file, and this window will
      tell you exactly where it is.
    - It runs only when YOU log in, as you, with your permissions.
    - It still cannot spend money. There is no checkout in this
      program at all.

  TO UNDO
    Run "5 - Stop starting automatically", or delete the file.

  The Watcher opens a Chrome window while it runs. That window is
  signed out on purpose and stays open. If you would rather decide for
  yourself each day, say no here and keep using file 2.

NOTICE

read -r -p "  Type yes to turn it on, or press return to cancel: " ANSWER
if [ "$ANSWER" != "yes" ] && [ "$ANSWER" != "YES" ] && [ "$ANSWER" != "Yes" ]; then
  echo
  echo "  Nothing changed. Keep using '2 - Start watching' when you want it."
  echo
  read -r -p "Press return to close."
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" || exit 1
NPM="$(command -v npm)"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pokemon.watcher</string>
  <key>ProgramArguments</key>
  <array><string>$NPM</string><string>run</string><string>watch</string></array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HERE/logs/console.log</string>
  <key>StandardErrorPath</key><string>$HERE/logs/console.log</string>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST" 2>/dev/null

echo
echo "  Done. It will start when you next log in."
echo
echo "  The file is here, and you can open or delete it any time:"
echo "  $PLIST"
echo
read -r -p "Press return to close."

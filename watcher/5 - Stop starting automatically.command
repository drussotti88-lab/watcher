#!/bin/bash
# Undoes "4 - Start automatically". Leaves everything else alone.
cd "$(dirname "$0")" || exit 1
PLIST="$HOME/Library/LaunchAgents/com.pokemon.watcher.plist"

if [ ! -f "$PLIST" ]; then
  echo
  echo "  It was not set to start automatically. Nothing to undo."
  echo
  read -r -p "Press return to close."
  exit 0
fi

launchctl unload "$PLIST" 2>/dev/null
rm -f "$PLIST"
echo
echo "  Removed. The Watcher will not start on its own any more."
echo
echo "  If it is running right now it keeps running — use"
echo "  '3 - Stop watching' to stop it."
echo
read -r -p "Press return to close."

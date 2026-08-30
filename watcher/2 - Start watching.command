#!/bin/bash
# Double-click to start watching. Leave the window open.
cd "$(dirname "$0")" || exit 1
echo
echo "  Starting. A Chrome window will open and stay open — that is the point."
echo "  It is signed out on purpose and never touches an account with a card."
echo
echo "  Leave both windows alone. To stop properly, use '3 - Stop watching'."
echo
npm run watch
echo
read -r -p "The Watcher has stopped. Press return to close."

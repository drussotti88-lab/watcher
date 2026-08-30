#!/bin/bash
# Double-click this once, the first time.
cd "$(dirname "$0")" || exit 1
echo
echo "  Installing what the Watcher needs. This takes a minute or two."
echo
npm install || { echo; echo "  That did not finish — the reason is above."; read -r -p "Press return to close."; exit 1; }
npm run setup || { echo; read -r -p "Press return to close."; exit 1; }
echo
echo "  Done. From now on, use '2 - Start watching'."
echo
read -r -p "Press return to close."

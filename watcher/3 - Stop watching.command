#!/bin/bash
# Double-click to stop the Watcher cleanly.
cd "$(dirname "$0")" || exit 1
npm run stop
echo
read -r -p "Press return to close."

#!/usr/bin/env python3
"""Start PokeTrack and open it in your browser.

Windows: double-click START PokeTrack.bat
Anywhere: python run.py
"""
import socket
import sys
import threading
import webbrowser

MIN_PYTHON = (3, 8)
if sys.version_info < MIN_PYTHON:
    sys.exit("PokeTrack needs Python %d.%d or newer. You have %s."
             % (MIN_PYTHON[0], MIN_PYTHON[1], sys.version.split()[0]))

from poketrack import web  # noqa: E402


def free_port(preferred=8765):
    for port in [preferred] + list(range(8766, 8800)):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return 0


def main():
    port = free_port()
    server = web.serve("127.0.0.1", port)
    url = "http://127.0.0.1:%d/" % port

    print("=" * 58)
    print("  PokeTrack is running")
    print("  Open this in your browser:  %s" % url)
    print("  Close this window (or press Ctrl+C) to stop it.")
    print("=" * 58)

    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped. Your data is safe in the data folder.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

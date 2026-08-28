PokeTrack
=========

Double-click  START PokeTrack.bat  to run it.

First time? Open  SETUP GUIDE.html  in your browser and follow the seven steps.
It covers installing Python and getting the app password your email provider
needs.

What's in here
--------------
START PokeTrack.bat   Launches the app and opens your browser.
SETUP GUIDE.html      The full walkthrough. Start here.
run.py                What the .bat file actually runs.
poketrack\            The application code.
tests\                Self-test and demo-data scripts (optional).
data\                 Created on first run. Your orders, rules and settings
                      live here -- this is the folder to back up.

Nothing is uploaded anywhere. The app only connects to your own mail server.

Optional
--------
python tests\test_app.py   Runs the built-in self-test.
python tests\seed_demo.py  Loads fake orders so you can try the dashboard
                           before connecting a real inbox.

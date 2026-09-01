# Setting up Phantom

You have been given three things: a **web address** for the app, a **name and
password** to sign in with, and a **token** for this program. Keep the password
and the token the way you'd keep any password.

## What this is

Two halves.

The **app** is a website — that's the address you were given, and it works on
your phone. It holds your watchlist and remembers what happened.

The **Phantom** is this folder, and it runs on your computer. It opens a Chrome
window and looks at product pages. It has to run on your machine rather than on
a server because Target, Walmart and Pokémon Center all refuse a datacentre
outright — a real browser on a home connection is the only thing they answer.

**So: nothing in your app updates unless Phantom is running.** An empty
dashboard almost always means Phantom isn't on.

## Before you start

**Node 22.6 or newer.** Get the LTS installer from
[nodejs.org](https://nodejs.org) and accept the defaults. If you're not sure
whether you have it, don't check — just run step 1 below and it will tell you.

**Google Chrome**, installed normally. Not Edge, not a bundled browser: the
shops answer a browser somebody actually uses.

## Setting up — three files, in order

Unzip this folder somewhere you'll find again — Documents is fine, a synced
cloud folder is not, because two machines fighting over the same profile causes
strange failures.

**1 — Set up.** Double-click it once. It checks your Node and Chrome, installs
what's needed, then asks for the app address and your token. It checks both
against the live app *before* writing anything, so if one is wrong it tells you
which.

**2 — Start watching.** Double-click. A terminal window opens, then a Chrome
window. **Leave both alone.** That Chrome is signed out on purpose — it does the
looking and nothing else, and it never touches an account with a card in it.

**3 — Stop watching.** Double-click when you want it to stop. Don't just close
the windows: stopping properly lets it finish the check it's on, close Chrome
and send the last of its log. Killing it does none of that, and Chrome comes
back next time complaining it didn't shut down correctly.

On a Mac the files end in `.command`. If double-clicking does nothing, open
Terminal, type `chmod +x ` (with the space), drag the folder in, and press
return.

## Optional — starting it automatically

**4 — Start automatically.** Your app only updates while Phantom is
running, so after a restart it's off until somebody notices, and restocks often
land at three in the morning. This makes it start when you log in.

It tells you exactly what it changes before it changes anything, and it needs
you to type `yes`. What it actually does:

- Windows: writes one small file into **your own** Startup folder.
- macOS: adds one login item to your own account.

No administrator rights, nothing installed system-wide, nothing hidden — it's
one readable file and the window prints its full path. It runs only when *you*
log in, as you. It still cannot spend money; there's no checkout in this
program at all.

**5 — Stop starting automatically** undoes it, and so does deleting that file
yourself. Neither one stops a Phantom that's already running — use **3** for
that.

If you'd rather decide day by day, skip both and keep using **2**.

## Using it

Sign in to the app with the name and password you were given. Add a product by
pasting a Target, Walmart or Pokémon Center link into it.

Adding something starts it **watching** — never armed, never with a price
ceiling. Watching means it looks and tells you. Nothing here can spend money:
there's no checkout code in this system at all.

Things worth knowing:

- **Pre-orders are not stock.** A pre-order takes your money now and ships
  whenever the publisher says. The app labels them, and missions skip them by
  default.
- **A Walmart or Target link can be a reseller.** When a shop is out of stock its
  own listing stays up and the buy box falls to a marketplace seller, sometimes
  at forty times the price. The app says "*N* resellers have the buy box" when
  that's the case, so clicking through is never a surprise.
- **"usually $X"** on a find is what that kind of product normally costs at a
  shop that isn't reselling. It's a sanity check, not the official price —
  there isn't one that retailers publish.
- **`10+ available`** means at least ten. The shops don't publish a real number
  above a ceiling, so neither do we.

## When something looks wrong

Run **2 — Start watching** and read the first few lines. Almost everything
announces itself there.

| What you see | What it means |
|---|---|
| `Unknown file extension ".ts"` | Node is too old. Install the LTS from nodejs.org, then reopen the window. |
| `npm is not recognised` | Node isn't installed, or the window was open before you installed it. Close it and open a new one. |
| `did not recognise the token` | Ask for a fresh token. Issuing a new one retires the old one, so an older token stops working. |
| `Could not reach …` | The address is wrong, or you're offline. |
| `challenged — standing down` | A shop asked to check you're human. It backs off and tries later. Nothing is broken. |
| A gap in the log | It batches what it sends. A minute or two of quiet is it working. |
| Chrome says "Restore pages?" | Something killed it rather than stopping it. Dismiss the bubble; use **3 — Stop watching** next time. |

If none of that fits, run `npm run once` in the folder — one pass, then it exits,
and it prints what it saw. That's usually enough to tell whether the problem is
Phantom, the app, or the shop having a bad morning.

## What it will not do

It does not buy anything. Checkout isn't built. When it is, it'll be something
turned on deliberately, per product, with a price ceiling — and a mission will
refuse a marketplace seller before it even looks at the price.

# Setting up Phantom

You were given an **invite link** (or a name and password) for the app. The
app itself gives you this program and a **token** for it — the "Phantom on
your computer" step of the tour, or the same card in Settings. Treat the token
like a password: it is shown once, and pressing the button again makes a new
one.

## What this is

Two halves.

The **app** is a website — it works on your phone. It holds your watchlist and
remembers what happened.

**Phantom** is this folder, and it runs on your computer. It opens a Chrome
window and reads product pages. It has to run on your machine rather than on
a server because Target, Walmart and Pokémon Center all refuse a datacentre
outright — a real browser on a home connection is the only thing they answer.

**Nothing in your app updates unless Phantom is running.** An empty dashboard
almost always means Phantom isn't on.

## Before you start

**Node 22.6 or newer.** Get the LTS installer from
[nodejs.org](https://nodejs.org) and accept the defaults. Not sure if you have
it? Run step 1 anyway — it tells you.

**Google Chrome**, installed normally. Not Edge, not a bundled browser.

## Setting up — three files, in order

Unzip this folder somewhere you'll find again. Documents is fine; a synced
cloud folder is not.

**1 — Set up.** Double-click once. It installs what's needed, then asks for the
app address and your token — both are on that card in the app, with a Copy
button — and checks them against the live app before writing anything.

**2 — Start watching.** Double-click. A terminal opens, then a Chrome window.
**Leave both alone.** That Chrome is signed out on purpose — it looks and
nothing else, and never touches an account with a card in it. If Phantom
crashes, this window restarts it.

**3 — Stop watching.** Use this rather than closing the windows. It lets Phantom
finish the check it's on, close Chrome and send the last of its log.

On a Mac the files end in `.command`. If double-clicking does nothing, open
Terminal, type `chmod +x ` (with the space), drag the folder in, press return.

## Optional — keeping it running

**4 — Start automatically** makes Phantom start when you log in; **5** undoes
it. **6 — Keep it running** restarts it if the whole window disappears; **7**
undoes that. Each says exactly what it changes and asks you to type `yes`. None
needs administrator rights.

## Using it

Sign in to the app. It walks you through the first time. Pick products from
the catalogue, or paste a Target, Walmart or Pokémon Center link — a link goes
to the catalogue owner, and once added it lands on your Missions.

Everything starts **watching**: it looks and tells you. Alerts arrive in the
Discord room the app points you to.

Worth knowing:

- **Pre-orders are not stock.** The app labels them; missions skip them by
  default.
- **Only the shop itself counts.** When Walmart or Target is out, resellers
  take over the same page at silly prices. Phantom reads who is selling and
  ignores anyone but the retailer. A find card that says **NOT Walmart** or
  **OVER MSRP** is telling you that.
- **`10+ available`** means at least ten. The shops don't publish more.

## Buying — only if your account may buy

Most accounts watch. If yours was set up to buy, the app says **MAY BUY** on
your profile, and Settings shows the money controls. Buying happens on **your**
computer, on **your** account and card — never on anyone else's.

**Target**

1. **9 — Sign in to Target.** A Chrome window opens on target.com. Sign in to
   your own Target account there, with your card already saved on the account.
   Close the window when you're done. That signed-in profile is used for
   nothing except placing an order.
2. In the app, set a **daily spend cap** in Settings. Nothing can be armed
   until one exists.
3. **Arm** a mission with a **price ceiling**. Armed means: when Target itself
   has it, at or under your ceiling, Phantom adds it to the cart and places
   the order. Once it buys, the mission disarms itself.
4. The first time, leave `"live": false` in `watcher.config.json` (it's the
   default). Phantom then runs the whole flow and stops on the line before the
   order button, and says so in the log. When you've seen it do that once,
   change it to `"live": true`.

Phantom never types a card number, never enters a password, and never answers
a "are you human" check. It presses the buttons a signed-in person would press,
and only for a mission you armed.

**Walmart**

Walmart's human check fails in any browser this program opens, even with a
person holding the button. So Walmart is not bought by Phantom. Instead:

1. Be signed in to Walmart in your **everyday** Chrome.
2. Walmart's queue drops are Wednesdays at 8pm Central. At about 7:55,
   double-click **8 — Hold my place** (the item number is at the top of the
   file — change it to what you're after).
3. The moment the page turns into a queue or the cart button lights up, it
   opens that page in your own browser, once. You take the place in line and
   buy it yourself.

## When something looks wrong

Run **2 — Start watching** and read the first lines. Almost everything
announces itself there.

| What you see | What it means |
|---|---|
| `Unknown file extension ".ts"` | Node is too old. Install the LTS from nodejs.org, then reopen the window. |
| `npm is not recognised` | Node isn't installed, or the window was open before you installed it. Close it and open a new one. |
| `did not recognise the token` | Press **Show my token** in the app again and run **1 — Set up** again. A new token retires the old one. |
| `Could not reach …` | The address is wrong, or you're offline. |
| `challenged — standing down` | A shop asked to check you're human. It backs off and tries later. Nothing is broken. |
| `stopped on the line before the button` | `live` is false. That's the dry run working. |
| A gap in the log | It batches what it sends. A minute or two of quiet is it working. |
| Chrome says "Restore pages?" | Something killed it rather than stopping it. Dismiss it; use **3** next time. |

If none of that fits, run `npm run once` in the folder — one pass, then it
exits, printing what it saw.

## What it will not do

It won't chase resellers or anything over the shop's own price. It won't
answer a bot check, hide that it's a browser, or skip a queue. It won't spend
without an armed mission, a ceiling and a daily cap, and it will never spend
from anyone's account but the one signed in on this computer.

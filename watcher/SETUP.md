# Setting up the Watcher

You have been given two things: a **web address** for the app, and a **token**
of your own. Keep the token the way you'd keep a password.

## What this actually is

Two halves. The **app** is a website — that's the address you were given, and
you can open it on your phone. It holds your watchlist and remembers what
happened.

The **Watcher** is this folder, and it runs on your computer. It opens a Chrome
window and looks at product pages. It has to run on your machine rather than
on a server because Target, Walmart and Pokémon Center all refuse a datacentre
outright — a real browser on a home connection is the only thing they answer.

That means: **nothing in your app updates unless the Watcher is running.** An
empty dashboard usually means the Watcher isn't on.

## What you need first

- **Node 22 or newer.** Check with `node --version`. If it's missing or older,
  get it from nodejs.org.
- **Google Chrome**, installed normally.

## Setting up

Open a terminal in this folder and run:

```
npm install
npm run setup
```

It asks for the address and the token, checks them against the app before
writing anything, and tells you which of the two is wrong if either is. Then:

```
npm run watch
```

A Chrome window opens and stays open. **That window is signed out on purpose.**
It does the looking and nothing else, and it never touches an account with a
card in it. Leave it alone and leave it running.

To stop it, run `npm run stop` in a second terminal — don't just close the
window or kill it. Stopping properly lets it close Chrome and send the last of
its log; killing it does neither, and Chrome comes back next time complaining
that it didn't shut down correctly.

## Using it

Add a product by pasting a Target, Walmart or Pokémon Center link into the app.
It starts **watching** immediately — never armed, never with a price ceiling.
Watching just means it looks and tells you.

Things worth knowing:

- **Pre-orders are not stock.** A pre-order takes your money now and ships
  whenever the publisher says. Missions skip them by default; there's a setting
  per product if you want one.
- **Marketplace sellers are not Target.** A Target URL can be a reseller at four
  times the price. The app says which is which.
- **`10+ available`** means at least ten. The retailers don't publish a real
  number above a ceiling, so neither do we.

## When something looks wrong

Run `npm run once` — one pass, then it exits, and it prints what it saw. That's
usually enough to tell whether the problem is the Watcher, the app, or the shop
having a bad morning.

Two normal things that look alarming:

- **A challenge page.** Occasionally a retailer wants to check you're human. The
  Watcher notices, backs off and tries later. Nothing is broken.
- **A gap in the log.** The Watcher batches what it sends. A minute or two of
  silence is it working, not it stopping.

## What it will not do

It does not buy anything. Checkout isn't built yet, and when it is it will be
something you turn on deliberately, per product, with a price ceiling you set.
Nothing here can spend money today.

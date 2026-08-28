"""Every page the app serves, built as plain HTML strings."""
from datetime import datetime

from . import charts, money, rules as rules_mod
from .charts import esc, usd

NAV = [
    ("/", "Dashboard"),
    ("/orders", "Orders"),
    ("/releases", "Release dates"),
    ("/rules", "Rules"),
    ("/review", "Needs review"),
    ("/accounts", "Email accounts"),
]

STATUS_LABEL = dict(preorder="Pre-order", open="Ordered", shipped="Shipped",
                    delivered="Delivered", cancelled="Cancelled")


def fmt_date(iso, with_year=True):
    if not iso:
        return "—"
    try:
        d = datetime.strptime(iso[:10], "%Y-%m-%d")
        return d.strftime("%b %-d, %Y" if with_year else "%b %-d")
    except (ValueError, TypeError):
        try:
            d = datetime.strptime(iso[:10], "%Y-%m-%d")
            return d.strftime("%b %d, %Y" if with_year else "%b %d")
        except Exception:
            return iso[:10]


def _clip(text, limit):
    """Trim to a comma or word boundary rather than mid-word."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for sep in (", ", " · ", " "):
        i = cut.rfind(sep)
        if i > limit * 0.6:
            return cut[:i] + "…"
    return cut + "…"


def status_tag(status):
    return '<span class="tag %s">%s</span>' % (esc(status), esc(STATUS_LABEL.get(status, status)))


def layout(title, body, active="/", flash=None, flash_bad=False,
           review_count=0, scanning=False):
    nav = []
    for href, label in NAV:
        cls = ' class="active"' if href == active else ""
        badge = ('<span class="pill">%d</span>' % review_count) if (
            href == "/review" and review_count) else ""
        nav.append('<a href="%s"%s>%s%s</a>' % (href, cls, esc(label), badge))

    flash_html = ""
    if flash:
        flash_html = '<div class="flash%s">%s</div>' % (
            " bad" if flash_bad else "", esc(flash))

    scan_button = (
        '<form method="post" action="/scan"><button style="width:100%%"%s>%s</button></form>'
        % (" disabled" if scanning else "", "Scanning…" if scanning else "Scan my email")
    )

    return """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(title)s · PokeTrack</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>%%F0%%9F%%93%%A6</text></svg>">
</head><body data-scanning="%(scanning)s">
<div class="shell">
<nav class="side">
  <div class="brand">PokeTrack<small>orders &amp; release-day cash</small></div>
  %(nav)s
  %(scan)s
</nav>
<main>%(flash)s%(body)s</main>
</div>
<script src="/static/app.js"></script>
</body></html>""" % dict(
        title=esc(title), nav="".join(nav), scan=scan_button,
        flash=flash_html, body=body, scanning="1" if scanning else "0")


# ---------------------------------------------------------------- dashboard

def dashboard(conn):
    k = money.kpis(conn)
    buckets, unscheduled = money.due_breakdown(conn)
    history = money.spend_history(conn)
    split = money.status_split(conn)
    retailers = money.by_retailer(conn)
    upcoming = [b for b in buckets if b["date"] and b["date"] >= money.today()]

    if k["total_orders"] == 0:
        return _first_run(conn)

    tiles = [
        _tile("Still owed", usd(k["outstanding"]),
              "%d pre-order(s) and %d open order(s) not charged yet"
              % (k["preorders"], k["open_orders"]), "hero"),
        _tile("Due in 30 days", usd(k["due_30"]),
              "Money you need ready by %s" % fmt_date(money._add_days(money.today(), 30)),
              "warn" if k["due_30"] else ""),
        _tile("Next charge date",
              fmt_date(k["next_date"], False) if k["next_date"] else "—",
              usd(k["next_amount"]) + " on that day" if k["next_date"]
              else "No dated charges scheduled"),
        _tile("Spent this month", usd(k["spent_this_month"]),
              "Total charged all time: " + usd(k["charged"])),
    ]
    if k["unscheduled"]:
        tiles.append(_tile("No date yet", usd(k["unscheduled"]),
                           "Add release dates so this lands on the calendar"))

    body = ['<h1>Dashboard</h1>',
            '<p class="sub">What you have out there, and what you need cash ready for.</p>',
            '<div class="tiles">%s</div>' % "".join(tiles)]

    # --- cash due timeline -------------------------------------------------
    points = [dict(label=fmt_date(b["date"], False),
                   sub=b["date"][:4] if b["date"] else "",
                   value=b["amount"],
                   tip="%s — %s across %d order(s)"
                       % (fmt_date(b["date"]), usd(b["amount"]), len(b["lines"])))
              for b in upcoming]
    body.append(
        '<div class="card"><h2>Cash needed by release date'
        '<span class="note">upcoming charges only</span></h2>%s%s</div>'
        % (charts.vbars(points) if points else charts.empty(
            "Nothing scheduled yet. Add release dates so pre-orders land on the calendar."),
           _due_table(upcoming, unscheduled)))

    # --- two-up ------------------------------------------------------------
    split_rows = [dict(label="%s (%d)" % (s["label"], s["count"]), value=s["amount"],
                       color=_status_var(s["key"]),
                       tip="%s: %d order(s) worth %s"
                           % (s["label"], s["count"], usd(s["amount"])))
                  for s in split]
    body.append('<div class="card"><h2>Shipped vs still pending'
                '<span class="note">by order value</span></h2>%s%s</div>'
                % (charts.hbars(split_rows), _split_table(split)))

    hist_points = [dict(label=_month_label(h["month"]), sub="",
                        value=h["amount"],
                        tip="%s — %s across %d order(s)"
                            % (_month_label(h["month"], True), usd(h["amount"]), h["count"]))
                   for h in history]
    body.append('<div class="card"><h2>What you have actually spent'
                '<span class="note">charged orders, by month</span></h2>%s</div>'
                % (charts.vbars(hist_points, height=230)
                   if hist_points else charts.empty("No charged orders yet.")))

    if len(retailers) > 1:
        rows = [dict(label=r["retailer"], values=[r["spent"], r["owed"]]) for r in retailers]
        body.append('<div class="card"><h2>By store</h2>%s</div>' % charts.grouped_hbars(
            rows, [dict(label="Already spent", var="--series-1"),
                   dict(label="Still owed", var="--series-2")]))

    return "".join(body)


def _status_var(key):
    return {"preorder": "--series-2", "open": "--series-1", "shipped": "--series-3",
            "delivered": "--series-3", "cancelled": "--neutral"}.get(key, "--series-1")


def _month_label(m, long=False):
    try:
        d = datetime.strptime(m + "-01", "%Y-%m-%d")
        return d.strftime("%B %Y" if long else "%b")
    except Exception:
        return m


def _tile(k, v, d, cls=""):
    return ('<div class="tile %s"><div class="k">%s</div><div class="v">%s</div>'
            '<div class="d">%s</div></div>' % (cls, esc(k), esc(v), esc(d)))


def _due_table(buckets, unscheduled):
    rows = []
    for b in buckets:
        per_order = {}
        for l in b["lines"]:
            key = (l["retailer"], l["order_no"], l["order_id"])
            per_order[key] = per_order.get(key, 0) + l["amount"]
        listed = sorted(per_order.items(), key=lambda kv: -kv[1])
        detail = ", ".join(
            "<a href='/orders/%d'>%s #%s</a> (%s)" % (oid, esc(store), esc(no), usd(amt))
            for (store, no, oid), amt in listed[:4])
        if len(listed) > 4:
            detail += " +%d more" % (len(listed) - 4)
        days = money._days_between(money.today(), b["date"])
        rows.append(
            "<tr><td class='nowrap'><strong>%s</strong><br><span class='small muted'>%s</span></td>"
            "<td class='num'><strong>%s</strong></td><td class='small'>%s</td></tr>"
            % (fmt_date(b["date"]),
               ("in %d days" % days) if days and days > 0 else "today",
               usd(b["amount"]), detail))
    if unscheduled["amount"]:
        seen = {}
        for l in unscheduled["lines"]:
            seen[(l["retailer"], l["order_no"], l["order_id"])] = True
        detail = ", ".join("<a href='/orders/%d'>%s #%s</a>" % (oid, esc(store), esc(no))
                           for store, no, oid in list(seen)[:5])
        rows.append("<tr><td class='nowrap'><strong>No date yet</strong><br>"
                    "<span class='small muted'><a href='/releases'>add a release date</a></span></td>"
                    "<td class='num'><strong>%s</strong></td><td class='small'>%s</td></tr>"
                    % (usd(unscheduled["amount"]), detail))
    if not rows:
        return ""
    return ('<div class="table-wrap"><table><thead><tr><th>Date</th>'
            '<th class="num">Amount</th><th>Orders</th></tr></thead><tbody>%s</tbody></table></div>'
            % "".join(rows))


def _split_table(split):
    if not split:
        return ""
    rows = "".join("<tr><td>%s</td><td class='num'>%d</td><td class='num'>%s</td></tr>"
                   % (esc(s["label"]), s["count"], usd(s["amount"])) for s in split)
    return ('<div class="table-wrap"><table><thead><tr><th>Status</th>'
            '<th class="num">Orders</th><th class="num">Value</th></tr></thead>'
            '<tbody>%s</tbody></table></div>' % rows)


def _first_run(conn):
    n_accounts = conn.execute("SELECT COUNT(*) c FROM accounts").fetchone()["c"]
    n_emails = conn.execute("SELECT COUNT(*) c FROM emails").fetchone()["c"]
    steps = [
        ("Connect an inbox", "/accounts",
         "Add each email address your orders land in. You will need an app password "
         "— the setup guide walks through it.", n_accounts > 0),
        ("Check your rules", "/rules",
         "Five starter rules are already set up for Pokemon Center and Target. "
         "Adjust them or add your own.", True),
        ("Scan your email", None,
         "Hit “Scan my email” in the sidebar. Nothing is sent anywhere — it reads "
         "your inbox and stores what it finds on this computer.", n_emails > 0),
        ("Add release dates", "/releases",
         "Type in when products actually drop so pre-orders show up on the cash "
         "timeline.", conn.execute("SELECT COUNT(*) c FROM releases").fetchone()["c"] > 0),
    ]
    items = []
    for i, (title, href, desc, done) in enumerate(steps, 1):
        mark = "✓" if done else str(i)
        link = ' — <a href="%s">go</a>' % href if href else ""
        items.append(
            '<div class="cond"><span class="mark %s">%s</span><div><strong>%s</strong>'
            '<div class="small muted">%s%s</div></div></div>'
            % ("yes" if done else "", mark, esc(title), esc(desc), link))
    return ('<h1>Welcome to PokeTrack</h1><p class="sub">Four steps and your dashboard '
            'fills itself in.</p><div class="card">%s</div>' % "".join(items))


# ------------------------------------------------------------------- orders

def orders_page(conn, q):
    status = q.get("status", "")
    retailer = q.get("retailer", "")
    search = q.get("q", "")

    where, args = ["1=1"], []
    if status:
        where.append("status = ?"); args.append(status)
    if retailer:
        where.append("retailer = ?"); args.append(retailer)
    if search:
        where.append("(order_no LIKE ? OR tag LIKE ? OR id IN "
                     "(SELECT order_id FROM items WHERE name LIKE ?))")
        args += ["%%%s%%" % search] * 3

    rows = conn.execute(
        "SELECT * FROM orders WHERE %s ORDER BY COALESCE(order_date, created_at) DESC, id DESC"
        % " AND ".join(where), args).fetchall()
    retailers = [r["retailer"] for r in conn.execute(
        "SELECT DISTINCT retailer FROM orders ORDER BY retailer") if r["retailer"]]

    opts = lambda values, cur, blank: "".join(
        '<option value="%s"%s>%s</option>' % (esc(v), " selected" if v == cur else "", esc(l))
        for v, l in [("", blank)] + list(values))

    filters = """<form class="filters" method="get">
      <div><label>Status</label><select name="status" data-autosubmit>%s</select></div>
      <div><label>Store</label><select name="retailer" data-autosubmit>%s</select></div>
      <div><label>Search</label><input type="text" name="q" value="%s" placeholder="order # or product"></div>
      <button class="ghost">Filter</button>
      <a class="btn ghost" href="/orders">Clear</a>
    </form>""" % (
        opts([(k, v) for k, v in STATUS_LABEL.items()], status, "All statuses"),
        opts([(r, r) for r in retailers], retailer, "All stores"),
        esc(search))

    total_owed = sum(r["total"] for r in rows if not r["charged"] and r["status"] in money.OUTSTANDING)

    body = ['<div class="spread"><div><h1>Orders</h1><p class="sub">%d order(s) · %s still owed</p></div>'
            '<a class="btn ghost" href="/orders/new">Add an order by hand</a></div>' % (
                len(rows), usd(total_owed)),
            filters]

    if not rows:
        body.append('<div class="card empty"><h3>No orders match</h3>'
                    '<p class="muted">Run a scan, or loosen the filters above.</p></div>')
        return "".join(body)

    trs = []
    for o in rows:
        items = money.order_items(conn, o["id"])
        names = ", ".join(i["name"] for i in items[:2]) or "—"
        if len(items) > 2:
            names += " +%d more" % (len(items) - 2)
        paid = ('<span class="tag paid">charged %s</span>' % fmt_date(o["charge_date"], False)
                if o["charged"] else '<span class="tag owed">not charged</span>')
        trs.append(
            "<tr><td class='nowrap'><a href='/orders/%d'><strong>#%s</strong></a>"
            "<br><span class='small muted'>%s</span></td>"
            "<td class='nowrap small'>%s</td><td class='small'>%s</td>"
            "<td class='nowrap'>%s</td><td class='nowrap'>%s</td>"
            "<td class='num nowrap'><strong>%s</strong></td></tr>"
            % (o["id"], esc(o["order_no"]), esc(o["retailer"] or "—"),
               fmt_date(o["order_date"]), esc(names), status_tag(o["status"]), paid,
               usd(o["total"])))
    body.append('<div class="card"><div class="table-wrap"><table><thead><tr>'
                '<th>Order</th><th>Ordered</th><th>Items</th><th>Status</th>'
                '<th>Payment</th><th class="num">Total</th></tr></thead>'
                '<tbody>%s</tbody></table></div></div>' % "".join(trs))
    return "".join(body)


def order_detail(conn, order_id):
    o = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if not o:
        return None
    items = money.order_items(conn, order_id)
    emails = conn.execute(
        "SELECT id, subject, received_at FROM emails WHERE order_id = ? ORDER BY received_at",
        (order_id,)).fetchall()

    item_rows = "".join(
        "<tr><td>%s</td><td class='num'>%d</td><td class='num'>%s</td>"
        "<td class='num'>%s</td></tr>"
        % (esc(i["name"]), i["qty"], usd(i["unit_price"]), usd(i["line_total"]))
        for i in items) or "<tr><td colspan='4' class='muted'>No line items were found in the email. Add them below if you want per-product release matching.</td></tr>"

    email_rows = "".join(
        "<li><a href='/email/%d'>%s</a> <span class='small muted'>%s</span></li>"
        % (e["id"], esc(e["subject"] or "(no subject)"), fmt_date(e["received_at"]))
        for e in emails) or "<li class='muted'>Added by hand — no source email.</li>"

    sel = lambda options, cur: "".join(
        '<option value="%s"%s>%s</option>' % (esc(v), " selected" if v == cur else "", esc(l))
        for v, l in options)

    form = """<form method="post" action="/orders/%(id)d" class="stack">
  <div class="row3">
    <div><label>Order number</label><input type="text" name="order_no" value="%(order_no)s"></div>
    <div><label>Store</label><input type="text" name="retailer" value="%(retailer)s"></div>
    <div><label>Order date</label><input type="date" name="order_date" value="%(order_date)s"></div>
  </div>
  <div class="row3">
    <div><label>Status</label><select name="status">%(status_opts)s</select></div>
    <div><label>Total</label><input type="number" step="0.01" name="total" value="%(total).2f"></div>
    <div><label>When does the card get charged?</label><select name="charge_timing">%(timing_opts)s</select></div>
  </div>
  <div class="row3">
    <div><label>Already charged?</label><select name="charged">%(charged_opts)s</select></div>
    <div><label>Charge date<span class="hint">Overrides everything else</span></label>
      <input type="date" name="charge_date" value="%(charge_date)s"></div>
    <div><label>Release date for this order<span class="hint">Used if no product match</span></label>
      <input type="date" name="release_date" value="%(release_date)s"></div>
  </div>
  <div class="row2">
    <div><label>Tracking</label><input type="text" name="tracking" value="%(tracking)s"></div>
    <div><label>Tag</label><input type="text" name="tag" value="%(tag)s"></div>
  </div>
  <div><label>Notes<span class="hint">Any order with notes or hand edits is protected from being overwritten by a rescan</span></label>
    <textarea name="notes">%(notes)s</textarea></div>
  <div class="actions"><button>Save changes</button>
    <a class="btn ghost" href="/orders">Back to orders</a></div>
</form>""" % dict(
        id=order_id, order_no=esc(o["order_no"]), retailer=esc(o["retailer"]),
        order_date=esc((o["order_date"] or "")[:10]),
        status_opts=sel(list(STATUS_LABEL.items()), o["status"]),
        total=o["total"] or 0,
        timing_opts=sel([(t, rules_mod.TIMING_LABELS[t])
                         for t in rules_mod.TIMINGS if t != "auto"], o["charge_timing"]),
        charged_opts=sel([("0", "Not yet — still owed"), ("1", "Yes, money is gone")],
                         str(o["charged"])),
        charge_date=esc((o["charge_date"] or "")[:10]),
        release_date=esc((o["release_date"] or "")[:10]),
        tracking=esc(o["tracking"]), tag=esc(o["tag"]), notes=esc(o["notes"]))

    add_item = """<form method="post" action="/orders/%d/item" class="stack">
      <div class="row3">
        <div><label>Product</label><input type="text" name="name" required></div>
        <div><label>Qty</label><input type="number" name="qty" value="1" min="1"></div>
        <div><label>Price each</label><input type="number" step="0.01" name="unit_price" value="0"></div>
      </div>
      <div class="actions"><button class="ghost small">Add line item</button></div>
    </form>""" % order_id

    locked = ", ".join(sorted(_locked_names(o))) or "none"
    return """<h1>Order #%s</h1>
<p class="sub">%s · %s · %s</p>
<div class="card"><h2>Line items</h2><div class="table-wrap"><table><thead><tr>
<th>Product</th><th class="num">Qty</th><th class="num">Each</th><th class="num">Line total</th>
</tr></thead><tbody>%s</tbody></table></div><hr style="border:none;border-top:1px solid var(--border);margin:16px 0">%s</div>
<div class="card"><h2>Details<span class="note">fields you change here are locked: %s</span></h2>%s</div>
<div class="card"><h2>Source emails</h2><ul>%s</ul></div>""" % (
        esc(o["order_no"]), esc(o["retailer"] or "Unknown"),
        STATUS_LABEL.get(o["status"], o["status"]), usd(o["total"]),
        item_rows, add_item, esc(locked), form, email_rows)


def _locked_names(o):
    import json
    try:
        return set(json.loads(o["locked"] or "[]"))
    except Exception:
        return set()


def new_order_form():
    sel = lambda options, cur: "".join(
        '<option value="%s"%s>%s</option>' % (esc(v), " selected" if v == cur else "", esc(l))
        for v, l in options)
    return """<h1>Add an order by hand</h1>
<p class="sub">For anything that never showed up in email, or that the scanner missed.</p>
<div class="card"><form method="post" action="/orders/new" class="stack">
  <div class="row3">
    <div><label>Order number</label><input type="text" name="order_no" required></div>
    <div><label>Store</label><input type="text" name="retailer" value="Pokemon Center"></div>
    <div><label>Order date</label><input type="date" name="order_date" value="%s"></div>
  </div>
  <div class="row3">
    <div><label>Status</label><select name="status">%s</select></div>
    <div><label>Total</label><input type="number" step="0.01" name="total" value="0" required></div>
    <div><label>When are you charged?</label><select name="charge_timing">%s</select></div>
  </div>
  <div class="row2">
    <div><label>Release date<span class="hint">Optional — when the money comes out</span></label>
      <input type="date" name="release_date"></div>
    <div><label>Tag</label><input type="text" name="tag"></div>
  </div>
  <div><label>Notes</label><textarea name="notes"></textarea></div>
  <div class="actions"><button>Create order</button><a class="btn ghost" href="/orders">Cancel</a></div>
</form></div>""" % (money.today(), sel(list(STATUS_LABEL.items()), "preorder"),
                    sel([(t, rules_mod.TIMING_LABELS[t]) for t in rules_mod.TIMINGS
                         if t != "auto"], "at_ship"))


# ----------------------------------------------------------------- releases

def releases_page(conn, edit_id=None):
    rows = money.upcoming_releases(conn, limit=500)
    editing = None
    if edit_id:
        editing = conn.execute("SELECT * FROM releases WHERE id = ?", (edit_id,)).fetchone()

    trs = []
    for r in rows:
        days = r["days_out"]
        when = ("in %d days" % days if days and days > 0
                else "today" if days == 0 else "%d days ago" % abs(days) if days else "")
        trs.append(
            "<tr><td><strong>%s</strong><br><span class='small muted'>matches: %s</span></td>"
            "<td class='nowrap'>%s<br><span class='small muted'>%s</span></td>"
            "<td class='small'>%s</td><td class='num'>%s</td><td class='num'><strong>%s</strong></td>"
            "<td class='nowrap'><a class='btn ghost small' href='/releases?edit=%d'>Edit</a> "
            "<form method='post' action='/releases/%d/delete' style='display:inline' "
            "data-confirm='Delete this release date?'><button class='ghost small'>Delete</button></form></td></tr>"
            % (esc(r["product"]), esc(r["match_text"] or r["product"]),
               fmt_date(r["release_date"]), esc(when), esc(r["retailer"] or "any store"),
               usd(r["est_price"]) if r["est_price"] else "—",
               usd(r["committed"]) if r["committed"] else "—", r["id"], r["id"]))

    table = ('<div class="table-wrap"><table><thead><tr><th>Product</th><th>Releases</th>'
             '<th>Store</th><th class="num">Est. price</th><th class="num">You owe</th>'
             '<th></th></tr></thead><tbody>%s</tbody></table></div>' % "".join(trs)
             ) if trs else ('<div class="empty"><h3>No release dates yet</h3>'
                            '<p class="muted">Add one below and any matching pre-order '
                            'jumps onto the cash timeline.</p></div>')

    e = editing
    form = """<form method="post" action="/releases" class="stack">
  <input type="hidden" name="id" value="%(id)s">
  <div class="row2">
    <div><label>Product name</label><input type="text" name="product" value="%(product)s" required
      placeholder="e.g. Mega Evolution Elite Trainer Box"></div>
    <div><label>Release date</label><input type="date" name="release_date" value="%(date)s" required></div>
  </div>
  <div><label>Match text
    <span class="hint">Comma-separated words to look for in your order line items. Leave blank to use the product name. Shorter is usually better — "mega evolution etb" beats the full title.</span></label>
    <input type="text" name="match_text" value="%(match)s"></div>
  <div class="row3">
    <div><label>Store <span class="hint">Optional — limits matching</span></label>
      <input type="text" name="retailer" value="%(retailer)s"></div>
    <div><label>Estimated price</label><input type="number" step="0.01" name="est_price" value="%(price)s"></div>
    <div><label>Notes</label><input type="text" name="notes" value="%(notes)s"></div>
  </div>
  <div class="actions"><button>%(verb)s</button>%(cancel)s</div>
</form>""" % dict(
        id=e["id"] if e else "", product=esc(e["product"]) if e else "",
        date=esc(e["release_date"]) if e else "",
        match=esc(e["match_text"]) if e else "",
        retailer=esc(e["retailer"]) if e else "",
        price=("%.2f" % e["est_price"]) if e and e["est_price"] else "",
        notes=esc(e["notes"]) if e else "",
        verb="Save changes" if e else "Add release date",
        cancel='<a class="btn ghost" href="/releases">Cancel</a>' if e else "")

    return """<h1>Release dates</h1>
<p class="sub">Tell the app when things actually drop. Any pre-order whose products match
lands on that date in the cash timeline.</p>
<div class="card"><h2>%s</h2>%s</div>
<div class="card"><h2>Your release calendar</h2>%s</div>""" % (
        "Edit release date" if e else "Add a release date", form, table)


# -------------------------------------------------------------------- rules

def rules_page(conn):
    rows = conn.execute("SELECT * FROM rules ORDER BY priority, id").fetchall()
    trs = []
    for r in rows:
        conds = rules_mod.check(r, dict(subject="", body="", from_addr="", from_name=""))
        summary = _clip(" · ".join("%s %s" % (name, req) for name, req, _ in conds)
                        or "no conditions", 165)
        trs.append(
            "<tr><td><strong>%s</strong>%s<br><span class='small muted'>%s</span></td>"
            "<td class='nowrap small'>%s</td><td class='nowrap small'>%s</td>"
            "<td class='num'>%d</td><td class='num'>%d</td>"
            "<td class='nowrap'><a class='btn ghost small' href='/rules/%d'>Edit</a></td></tr>"
            % (esc(r["name"]),
               "" if r["enabled"] else " <span class='tag'>off</span>",
               esc(summary),
               esc(r["retailer"] or "—"),
               esc(rules_mod.KIND_LABELS.get(r["kind"], r["kind"])),
               r["priority"], r["hits"], r["id"]))

    return """<div class="spread"><div><h1>Rules</h1>
<p class="sub">Rules decide which emails count and what they mean. Checked top to bottom —
the first one that matches an email wins.</p></div>
<div class="actions"><a class="btn ghost" href="/rules/test">Test a rule</a>
<a class="btn" href="/rules/new">New rule</a></div></div>
<div class="callout">Changed a rule? Hit <strong>Re-apply rules</strong> below to rebuild your
orders from email already downloaded — no need to re-scan your inbox.</div>
<div class="card"><div class="table-wrap"><table><thead><tr><th>Rule</th><th>Store</th>
<th>Treats email as</th><th class="num">Order</th><th class="num">Matches</th><th></th>
</tr></thead><tbody>%s</tbody></table></div></div>
<form method="post" action="/rebuild" data-confirm="Rebuild orders from stored email? Orders you edited or annotated by hand are kept.">
<button class="ghost">Re-apply rules to email already downloaded</button></form>""" % "".join(trs)


def rule_form(conn, rule_id=None):
    r = None
    if rule_id:
        r = conn.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
        if not r:
            return None
    g = (lambda k, d="": esc(r[k]) if r else d)

    sel = lambda options, cur: "".join(
        '<option value="%s"%s>%s</option>' % (esc(v), " selected" if str(v) == str(cur) else "", esc(l))
        for v, l in options)

    # Kept outside the main <form> below -- nested forms are invalid HTML and
    # browsers silently drop the inner one.
    delete = ("""<div class="card"><h2>Delete this rule</h2>
<p class="small muted">Orders already built from it stay put. Re-apply rules afterwards
if you want them rebuilt without it.</p>
<form method="post" action="/rules/%d/delete" data-confirm="Delete this rule?">
<button class="danger">Delete rule</button></form></div>""" % rule_id) if rule_id else ""

    return """<h1>%(title)s</h1>
<p class="sub">Fill in only the conditions you care about. Blank conditions are ignored.
Within one box, comma-separated terms mean "any of these".</p>
<div class="card"><form method="post" action="%(action)s" class="stack">
  <div class="row3">
    <div><label>Rule name</label><input type="text" name="name" value="%(name)s" required
      placeholder="e.g. Target Pokemon orders"></div>
    <div><label>Store this rule is for</label><input type="text" name="retailer" value="%(retailer)s"
      placeholder="Pokemon Center"></div>
    <div><label>Order it is checked in<span class="hint">Lower runs first</span></label>
      <input type="number" name="priority" value="%(priority)s"></div>
  </div>

  <h3 style="margin-top:6px">Match these emails</h3>
  <div><label>Sender contains<span class="hint">Usually the domain — pokemoncenter.com</span></label>
    <input type="text" name="from_contains" value="%(from_contains)s"></div>
  <div class="row2">
    <div><label>Subject contains<span class="hint">pre-order, preorder</span></label>
      <input type="text" name="subject_contains" value="%(subject_contains)s"></div>
    <div><label>Subject must NOT contain<span class="hint">cancel, shipped</span></label>
      <input type="text" name="subject_excludes" value="%(subject_excludes)s"></div>
  </div>
  <div><label>Body contains<span class="hint">Handy for stores that sell more than Pokemon — put "pokemon" here</span></label>
    <input type="text" name="body_contains" value="%(body_contains)s"></div>
  <div><label><input type="checkbox" name="use_regex" value="1"%(regex)s style="width:auto;margin-right:6px">
    Treat the boxes above as regular expressions</label></div>

  <h3 style="margin-top:6px">What a match means</h3>
  <div class="row3">
    <div><label>Treat matching email as</label><select name="kind">%(kinds)s</select></div>
    <div><label>When does the card get charged?</label><select name="charge_timing">%(timings)s</select></div>
    <div><label>Tag orders with</label><input type="text" name="tag" value="%(tag)s"></div>
  </div>

  <h3 style="margin-top:6px">Advanced — only if the parser gets it wrong</h3>
  <div class="row3">
    <div><label>Order number pattern</label><input type="text" class="code" name="order_no_regex" value="%(order_no_regex)s" placeholder="capture group 1"></div>
    <div><label>Total pattern</label><input type="text" class="code" name="total_regex" value="%(total_regex)s"></div>
    <div><label>Line item pattern<span class="hint">Use groups named name / qty / price</span></label>
      <input type="text" class="code" name="item_regex" value="%(item_regex)s"></div>
  </div>
  <div><label>Notes</label><textarea name="notes">%(notes)s</textarea></div>
  <div><label><input type="checkbox" name="enabled" value="1"%(enabled)s style="width:auto;margin-right:6px">
    Rule is on</label></div>
  <div class="actions"><button>Save rule</button>
    <a class="btn ghost" href="/rules">Cancel</a></div>
</form></div>%(delete)s""" % dict(
        title="Edit rule" if r else "New rule",
        action="/rules/%d" % rule_id if rule_id else "/rules/new",
        name=g("name"), retailer=g("retailer"),
        priority=r["priority"] if r else 100,
        from_contains=g("from_contains"), subject_contains=g("subject_contains"),
        subject_excludes=g("subject_excludes"), body_contains=g("body_contains"),
        regex=" checked" if r and r["use_regex"] else "",
        kinds=sel([(k, rules_mod.KIND_LABELS[k]) for k in rules_mod.KINDS],
                  r["kind"] if r else "auto"),
        timings=sel([(t, rules_mod.TIMING_LABELS[t]) for t in rules_mod.TIMINGS],
                    r["charge_timing"] if r else "auto"),
        tag=g("tag"), order_no_regex=g("order_no_regex"), total_regex=g("total_regex"),
        item_regex=g("item_regex"), notes=g("notes"),
        enabled=" checked" if (not r or r["enabled"]) else "",
        delete=delete)


def rule_tester(conn, sample=None, result=None):
    recent = conn.execute(
        "SELECT id, subject, from_addr, received_at, status FROM emails "
        "ORDER BY received_at DESC LIMIT 25").fetchall()
    options = "".join('<option value="%d"%s>%s — %s</option>'
                      % (e["id"], " selected" if sample and sample.get("id") == e["id"] else "",
                         esc((e["subject"] or "(no subject)")[:70]), esc(e["from_addr"]))
                      for e in recent)

    s = sample or {}
    form = """<form method="post" action="/rules/test" class="stack">
  <div><label>Pick a stored email%s</label><select name="email_id" data-autosubmit>
    <option value="">— or paste one below —</option>%s</select></div>
  <div class="row2">
    <div><label>From</label><input type="text" name="from_addr" value="%s"></div>
    <div><label>Subject</label><input type="text" name="subject" value="%s"></div>
  </div>
  <div><label>Body</label><textarea name="body" style="min-height:150px">%s</textarea></div>
  <div class="actions"><button>See which rule wins</button></div>
</form>""" % ("" if recent else '<span class="hint">Nothing scanned yet — paste an email below</span>',
              options, esc(s.get("from_addr", "")), esc(s.get("subject", "")),
              esc(s.get("body", "")))

    return """<h1>Test a rule</h1>
<p class="sub">Paste an email (or pick one you already downloaded) and see exactly which rule
catches it and what gets pulled out.</p>
<div class="card">%s</div>%s""" % (form, result or "")


def tester_result(conn, email, winner, parsed, all_checks):
    blocks = []
    for rule, conds in all_checks:
        won = winner and rule["id"] == winner["id"]
        rows = "".join(
            '<div class="cond"><span class="mark %s">%s</span><div>%s <code>%s</code></div></div>'
            % ("yes" if ok else "no", "✓" if ok else "✕", esc(name), esc(req))
            for name, req, ok in conds) or '<div class="cond muted">This rule has no conditions, so it never matches.</div>'
        blocks.append(
            '<div class="card" style="%s"><h2>%s%s<span class="note">priority %d</span></h2>%s</div>'
            % ("border-color:var(--series-1);border-width:1.5px" if won else "",
               esc(rule["name"]),
               ' <span class="tag open">winner</span>' if won else
               (' <span class="tag">off</span>' if not rule["enabled"] else ""),
               rule["priority"], rows))

    if not winner:
        head = ('<div class="card"><h2>No rule matched</h2><p class="muted">This email would be '
                'ignored. Add or loosen a rule below.</p></div>')
    else:
        items = "".join("<li>%s × %d — %s</li>" % (esc(i["name"]), i["qty"], usd(i["line_total"]))
                        for i in parsed["items"]) or "<li class='muted'>none found</li>"
        problems = ("<p class='small' style='color:var(--series-2)'>⚠ %s</p>"
                    % esc("; ".join(parsed["problems"]))) if parsed["problems"] else ""
        head = """<div class="card"><h2>“%s” wins — here is what it would record</h2>
<div class="table-wrap"><table><tbody>
<tr><th>Store</th><td>%s</td></tr>
<tr><th>Order number</th><td class="mono">%s</td></tr>
<tr><th>Total</th><td>%s</td></tr>
<tr><th>Status</th><td>%s</td></tr>
<tr><th>Charged</th><td>%s</td></tr>
<tr><th>Line items</th><td><ul style="margin:0;padding-left:18px">%s</ul></td></tr>
</tbody></table></div>%s</div>""" % (
            esc(winner["name"]), esc(parsed["retailer"] or "—"),
            esc(parsed["order_no"] or "not found"), usd(parsed["total"]),
            STATUS_LABEL.get(parsed["status"], parsed["status"]),
            esc(rules_mod.TIMING_LABELS.get(parsed["charge_timing"], parsed["charge_timing"])),
            items, problems)

    return head + '<h2 style="margin:22px 0 12px">Every rule, in the order they are checked</h2>' + "".join(blocks)


# ------------------------------------------------------------------- review

def review_page(conn):
    rows = conn.execute(
        "SELECT e.*, r.name AS rule_name FROM emails e LEFT JOIN rules r ON r.id = e.rule_id "
        "WHERE e.status = 'needs_review' ORDER BY e.received_at DESC LIMIT 200").fetchall()
    ignored = conn.execute(
        "SELECT COUNT(*) c FROM emails WHERE status = 'ignored'").fetchone()["c"]

    if not rows:
        table = ('<div class="empty"><h3>Nothing needs your attention</h3>'
                 '<p class="muted">Every matched email parsed cleanly.</p></div>')
    else:
        trs = "".join(
            "<tr><td><a href='/email/%d'>%s</a><br><span class='small muted'>%s</span></td>"
            "<td class='nowrap small'>%s</td><td class='small'>%s</td>"
            "<td class='nowrap'>%s</td></tr>"
            % (e["id"], esc((e["subject"] or "(no subject)")[:90]), esc(e["from_addr"]),
               fmt_date(e["received_at"]), esc(e["note"]),
               ("<a class='btn ghost small' href='/orders/%d'>Fix order</a>" % e["order_id"])
               if e["order_id"] else
               "<a class='btn ghost small' href='/orders/new'>Add by hand</a>")
            for e in rows)
        table = ('<div class="table-wrap"><table><thead><tr><th>Email</th><th>Received</th>'
                 '<th>What went wrong</th><th></th></tr></thead><tbody>%s</tbody></table></div>' % trs)

    return """<h1>Needs review</h1>
<p class="sub">Emails a rule caught but the parser could not fully read. Fix the order by hand,
or tighten the rule's patterns.</p>
<div class="card">%s</div>
<p class="small muted">%d email(s) matched no rule at all and were ignored.
<a href="/rules/test">Test them against your rules</a> if something is missing.</p>""" % (
        table, ignored)


def email_page(conn, email_id):
    e = conn.execute(
        "SELECT e.*, r.name AS rule_name, a.email AS account FROM emails e "
        "LEFT JOIN rules r ON r.id = e.rule_id LEFT JOIN accounts a ON a.id = e.account_id "
        "WHERE e.id = ?", (email_id,)).fetchone()
    if not e:
        return None
    link = ("<a class='btn ghost' href='/orders/%d'>Open the order</a>" % e["order_id"]
            if e["order_id"] else "")
    return """<h1>%s</h1>
<p class="sub">From %s · %s · inbox %s</p>
<div class="card"><div class="table-wrap"><table><tbody>
<tr><th>Matched rule</th><td>%s</td></tr>
<tr><th>Parse status</th><td>%s</td></tr>
<tr><th>Note</th><td>%s</td></tr>
</tbody></table></div><div class="actions" style="margin-top:14px">%s
<a class="btn ghost" href="/rules/test?email_id=%d">Test rules against this email</a>
<a class="btn ghost" href="/review">Back</a></div></div>
<div class="card"><h2>What the app read</h2><pre class="raw">%s</pre></div>""" % (
        esc(e["subject"] or "(no subject)"), esc(e["from_addr"]),
        fmt_date(e["received_at"]), esc(e["account"] or "—"),
        esc(e["rule_name"] or "none"), esc(e["status"]), esc(e["note"] or "—"),
        link, email_id, esc(e["body"] or ""))


# ----------------------------------------------------------------- accounts

def accounts_page(conn):
    rows = conn.execute("SELECT * FROM accounts ORDER BY id").fetchall()
    trs = "".join(
        "<tr><td><strong>%s</strong><br><span class='small muted'>%s</span></td>"
        "<td class='small mono'>%s:%d</td><td class='small'>%s</td>"
        "<td class='small'>%s</td>"
        "<td class='nowrap'><form method='post' action='/accounts/%d/delete' "
        "data-confirm='Remove this inbox? Emails already downloaded are kept.'>"
        "<button class='ghost small'>Remove</button></form></td></tr>"
        % (esc(a["label"]), esc(a["email"]), esc(a["imap_host"]), a["imap_port"],
           esc(a["folder"]), esc(a["last_status"] or "not scanned yet"), a["id"])
        for a in rows)
    table = ('<div class="table-wrap"><table><thead><tr><th>Inbox</th><th>Server</th>'
             '<th>Folder</th><th>Last scan</th><th></th></tr></thead><tbody>%s</tbody>'
             '</table></div>' % trs) if rows else (
        '<div class="empty"><h3>No inboxes connected</h3>'
        '<p class="muted">Add one below to start pulling in orders.</p></div>')

    return """<h1>Email accounts</h1>
<p class="sub">Add every inbox your orders land in. Everything stays on this computer —
nothing is uploaded anywhere.</p>
<div class="callout"><strong>You need an app password, not your normal password.</strong>
Gmail: turn on 2-Step Verification, then visit your Google Account → Security → App passwords.
Outlook: Security → Advanced security options → App passwords. Yahoo: Account Security →
Generate app password. Paste that 16-character code below.</div>
<div class="card"><h2>Add an inbox</h2>
<form method="post" action="/accounts" class="stack">
  <div class="row2">
    <div><label>Email address</label><input type="email" name="email" required
      placeholder="you@gmail.com"></div>
    <div><label>App password</label><input type="password" name="password" required
      placeholder="16-character app password"></div>
  </div>
  <div class="row3">
    <div><label>Nickname</label><input type="text" name="label" placeholder="Main inbox"></div>
    <div><label>IMAP server<span class="hint">Leave blank and I will work it out</span></label>
      <input type="text" name="imap_host" placeholder="auto"></div>
    <div><label>Folder</label><input type="text" name="folder" value="INBOX"></div>
  </div>
  <div class="row2">
    <div><label>How far back to look<span class="hint">In days</span></label>
      <input type="number" name="since_days" value="540"></div>
    <div style="align-self:end"><label>&nbsp;</label>
      <button name="action" value="test" class="ghost" style="width:100%%">Test connection only</button></div>
  </div>
  <div class="actions"><button name="action" value="save">Save inbox</button></div>
</form></div>
<div class="card"><h2>Connected inboxes</h2>%s</div>""" % table

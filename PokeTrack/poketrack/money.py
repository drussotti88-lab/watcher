"""Work out what has already been paid and what is still coming due."""
from collections import defaultdict
from datetime import date, datetime

LIVE = ("preorder", "open", "shipped", "delivered")
OUTSTANDING = ("preorder", "open")


def today():
    return date.today().isoformat()


def month_of(iso):
    return (iso or "")[:7]


def _release_terms(rel):
    raw = rel["match_text"] or rel["product"]
    return [t.strip().lower() for t in raw.split(",") if t.strip()]


def match_release(releases, text, retailer=""):
    """Best (most specific) release whose match text appears in `text`."""
    blob = (text or "").lower()
    if not blob:
        return None
    best, best_len = None, 0
    for rel in releases:
        if rel["retailer"] and retailer and rel["retailer"].lower() != retailer.lower():
            continue
        for term in _release_terms(rel):
            if term and term in blob and len(term) > best_len:
                best, best_len = rel, len(term)
    return best


def order_items(conn, order_id):
    return conn.execute(
        "SELECT * FROM items WHERE order_id = ? ORDER BY id", (order_id,)).fetchall()


def due_breakdown(conn):
    """Every dollar not yet charged, bucketed by the date it comes due."""
    releases = conn.execute("SELECT * FROM releases").fetchall()
    orders = conn.execute(
        "SELECT * FROM orders WHERE charged = 0 AND status IN (?, ?) ORDER BY order_date",
        OUTSTANDING).fetchall()

    buckets = defaultdict(lambda: dict(date=None, amount=0.0, lines=[]))
    unscheduled = dict(date=None, amount=0.0, lines=[])

    for o in orders:
        items = order_items(conn, o["id"])
        allocations = []

        if o["charge_date"]:
            allocations.append((o["charge_date"], o["total"], "date set by you"))
        elif o["release_date"]:
            allocations.append((o["release_date"], o["total"], "release date on this order"))
        elif o["charge_timing"] == "at_order":
            allocations.append((o["order_date"], o["total"], "charged at order time"))
        else:
            matched_value = 0.0
            per_date = defaultdict(float)
            reasons = {}
            for it in items:
                rel = match_release(releases, it["name"], o["retailer"])
                if rel:
                    per_date[rel["release_date"]] += it["line_total"]
                    matched_value += it["line_total"]
                    reasons[rel["release_date"]] = "release: %s" % rel["product"]
            leftover = round((o["total"] or 0) - matched_value, 2)
            for d, amount in per_date.items():
                allocations.append((d, amount, reasons[d]))
            if leftover > 0.01 or not per_date:
                fallback = match_release(
                    releases, " ".join([o["tag"] or ""] + [i["name"] for i in items]),
                    o["retailer"])
                if per_date and leftover > 0.01:
                    latest = max(per_date)
                    allocations.append((latest, leftover, "tax / shipping / unmatched"))
                elif fallback:
                    allocations.append((fallback["release_date"], o["total"],
                                        "release: %s" % fallback["product"]))
                else:
                    allocations.append((None, o["total"], "no release date set yet"))

        for when, amount, why in allocations:
            amount = round(amount or 0, 2)
            if amount <= 0:
                continue
            target = buckets[when] if when else unscheduled
            target["date"] = when
            target["amount"] = round(target["amount"] + amount, 2)
            target["lines"].append(dict(
                order_id=o["id"], order_no=o["order_no"], retailer=o["retailer"],
                amount=amount, why=why, status=o["status"]))

    ordered = [buckets[k] for k in sorted(buckets)]
    return ordered, unscheduled


def kpis(conn):
    row = conn.execute("""
        SELECT
          COALESCE(SUM(CASE WHEN charged = 0 AND status IN ('preorder','open')
                            THEN total END), 0) AS outstanding,
          COALESCE(SUM(CASE WHEN charged = 1 THEN total END), 0)         AS charged,
          COUNT(CASE WHEN status = 'preorder' THEN 1 END)                AS preorders,
          COUNT(CASE WHEN status = 'open' THEN 1 END)                    AS open_orders,
          COUNT(CASE WHEN status = 'shipped' THEN 1 END)                 AS shipped,
          COUNT(CASE WHEN status = 'delivered' THEN 1 END)               AS delivered,
          COUNT(CASE WHEN status = 'cancelled' THEN 1 END)               AS cancelled,
          COUNT(*)                                                       AS total_orders
        FROM orders""").fetchone()

    buckets, unscheduled = due_breakdown(conn)
    this_month = month_of(today())
    due_30 = 0.0
    horizon = _add_days(today(), 30)
    for b in buckets:
        if b["date"] and b["date"] <= horizon:
            due_30 += b["amount"]

    next_bucket = next((b for b in buckets if b["date"] and b["date"] >= today()), None)

    spent_this_month = conn.execute(
        "SELECT COALESCE(SUM(total), 0) s FROM orders "
        "WHERE charged = 1 AND substr(COALESCE(charge_date, order_date), 1, 7) = ?",
        (this_month,)).fetchone()["s"]

    return dict(
        outstanding=round(row["outstanding"], 2),
        charged=round(row["charged"], 2),
        due_30=round(due_30, 2),
        unscheduled=round(unscheduled["amount"], 2),
        spent_this_month=round(spent_this_month, 2),
        preorders=row["preorders"], open_orders=row["open_orders"],
        shipped=row["shipped"], delivered=row["delivered"],
        cancelled=row["cancelled"], total_orders=row["total_orders"],
        next_date=next_bucket["date"] if next_bucket else None,
        next_amount=round(next_bucket["amount"], 2) if next_bucket else 0.0,
    )


def _add_days(iso, days):
    d = datetime.strptime(iso, "%Y-%m-%d").date()
    return (d.fromordinal(d.toordinal() + days)).isoformat()


def spend_history(conn, months=12):
    rows = conn.execute("""
        SELECT substr(COALESCE(charge_date, order_date), 1, 7) AS m,
               COALESCE(SUM(total), 0) AS amount, COUNT(*) AS n
        FROM orders
        WHERE charged = 1 AND status != 'cancelled'
          AND COALESCE(charge_date, order_date) IS NOT NULL
        GROUP BY m ORDER BY m""").fetchall()
    found = {r["m"]: r for r in rows if r["m"]}
    if not found:
        return []
    # Fill the gaps so a quiet month reads as zero rather than disappearing.
    series, cursor, last = [], min(found), max(found)
    while cursor <= last:
        r = found.get(cursor)
        series.append(dict(month=cursor,
                           amount=round(r["amount"], 2) if r else 0.0,
                           count=r["n"] if r else 0))
        y, m = int(cursor[:4]), int(cursor[5:7])
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        cursor = "%04d-%02d" % (y, m)
    return series[-months:]


def status_split(conn):
    rows = conn.execute("""
        SELECT status, COUNT(*) n, COALESCE(SUM(total), 0) amount
        FROM orders GROUP BY status""").fetchall()
    label = dict(preorder="Pre-order", open="Ordered, not shipped", shipped="Shipped",
                 delivered="Delivered", cancelled="Cancelled")
    order = ["preorder", "open", "shipped", "delivered", "cancelled"]
    by = {r["status"]: r for r in rows}
    return [dict(key=s, label=label.get(s, s.title()),
                 count=by[s]["n"], amount=round(by[s]["amount"], 2))
            for s in order if s in by]


def by_retailer(conn):
    rows = conn.execute("""
        SELECT retailer,
               COALESCE(SUM(CASE WHEN charged = 1 THEN total END), 0) AS spent,
               COALESCE(SUM(CASE WHEN charged = 0 AND status IN ('preorder','open')
                                 THEN total END), 0) AS owed,
               COUNT(*) AS n
        FROM orders WHERE status != 'cancelled'
        GROUP BY retailer ORDER BY spent DESC""").fetchall()
    return [dict(retailer=r["retailer"] or "Unknown", spent=round(r["spent"], 2),
                 owed=round(r["owed"], 2), count=r["n"]) for r in rows]


def upcoming_releases(conn, limit=40):
    rows = conn.execute(
        "SELECT * FROM releases ORDER BY release_date").fetchall()
    buckets, _ = due_breakdown(conn)
    money_by_date = {b["date"]: b["amount"] for b in buckets}
    out = []
    for r in rows:
        out.append(dict(
            id=r["id"], product=r["product"], release_date=r["release_date"],
            est_price=r["est_price"], retailer=r["retailer"], notes=r["notes"],
            match_text=r["match_text"],
            committed=money_by_date.get(r["release_date"], 0.0),
            days_out=_days_between(today(), r["release_date"])))
    return out[:limit]


def _days_between(a, b):
    try:
        d1 = datetime.strptime(a, "%Y-%m-%d").date()
        d2 = datetime.strptime(b, "%Y-%m-%d").date()
        return (d2 - d1).days
    except Exception:
        return None

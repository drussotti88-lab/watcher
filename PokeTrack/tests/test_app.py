"""End-to-end check: sample emails -> rules -> orders -> dashboard numbers."""
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from poketrack import db  # noqa: E402

db.DATA_DIR = tempfile.mkdtemp(prefix="poketrack-test-")
db.DB_PATH = os.path.join(db.DATA_DIR, "test.db")

from poketrack import mailscan, money, parser, rules, views  # noqa: E402
import samples  # noqa: E402

FAIL = []


def check(label, got, want):
    ok = got == want
    print("  %s %-52s got %r" % ("PASS" if ok else "FAIL", label, got)
          + ("" if ok else "  want %r" % (want,)))
    if not ok:
        FAIL.append(label)


def approx(label, got, want, tol=0.02):
    ok = abs(float(got) - float(want)) <= tol
    print("  %s %-52s got %s" % ("PASS" if ok else "FAIL", label, got)
          + ("" if ok else "  want %s" % want))
    if not ok:
        FAIL.append(label)


def seed(conn):
    db.insert(conn, "accounts", dict(
        label="Test inbox", email="tester@example.com", imap_host="imap.example.com",
        imap_port=993, secret="", folder="INBOX", enabled=0))
    for i, (subject, addr, name, when, html) in enumerate(samples.SAMPLES):
        db.insert(conn, "emails", dict(
            account_id=1, message_id="<sample-%d@test>" % i, subject=subject,
            from_addr=addr, from_name=name, received_at=when,
            body=parser.html_to_text(html), status="new"))
    for product, date, match, price, retailer in samples.RELEASES:
        db.insert(conn, "releases", dict(
            product=product, release_date=date, match_text=match,
            est_price=price, retailer=retailer, notes=""))
    conn.commit()


def main():
    conn = db.init()
    seed(conn)

    print("\n[1] HTML flattening")
    text = parser.html_to_text(samples.PC_ORDER_HTML)
    check("order number is readable", "PC10488213" in text, True)
    check("accented product name decoded", "Pokémon" in text, True)
    check("script/style stripped", "<" not in text, True)

    print("\n[2] Field extraction")
    check("order number", parser.extract_order_no("Thanks for your order!", text), "PC10488213")
    approx("order total (not the subtotal)", parser.extract_total(text), 135.28)
    items = parser.extract_items(text)
    check("line item count", len(items), 2)
    check("first item name", items[0]["name"].startswith("Pokémon TCG: Prismatic"), True)
    check("first item qty", items[0]["qty"], 2)
    approx("first item line total", items[0]["line_total"], 99.98)
    check("subtotal/tax not treated as products",
          any("total" in i["name"].lower() or "tax" in i["name"].lower() for i in items), False)

    print("\n[3] Rules engine")
    rule_rows = conn.execute("SELECT * FROM rules").fetchall()
    pre = rules.pick(rule_rows, dict(subject="Your pre-order is confirmed",
                                     from_addr="orders@pokemoncenter.com",
                                     from_name="", body=""))
    check("pre-order email picks the pre-order rule", pre["name"], "Pokemon Center pre-orders")
    ship = rules.pick(rule_rows, dict(subject="Your order has shipped",
                                      from_addr="shipping@pokemoncenter.com",
                                      from_name="", body=""))
    check("shipping email picks the shipping rule", ship["name"], "Pokemon Center shipping notices")
    news = rules.pick(rule_rows, dict(subject="New arrivals at Pokemon Center",
                                      from_addr="news@pokemoncenter.com",
                                      from_name="", body="Shop the latest plush."))
    check("newsletter matches nothing", news, None)
    towels = rules.pick(rule_rows, dict(subject="Thanks for your order",
                                        from_addr="orders@oes.target.com", from_name="",
                                        body=parser.html_to_text(samples.TARGET_TOWELS_HTML)))
    check("Target order with no Pokemon in it is skipped", towels, None)
    check("IMAP sender list", sorted(rules.imap_senders(rule_rows)),
          ["oes.target.com", "pokemon.com", "pokemoncenter.com", "target.com"])

    print("\n[4] Ingest")
    stats = mailscan.apply_rules(conn, only_new=True)
    check("emails matched a rule", stats["matched"], 7)
    check("emails ignored", stats["ignored"], 2)
    check("orders created", stats["orders"], 6)

    o = conn.execute("SELECT * FROM orders WHERE order_no = 'PC10488213'").fetchone()
    check("shipped order picked up its status", o["status"], "shipped")
    check("shipped order tracking", o["tracking"], "1Z999AA10123456784")
    check("charged at order time for a normal order", o["charged"], 1)

    pre_o = conn.execute("SELECT * FROM orders WHERE order_no = 'PC10502991'").fetchone()
    check("pre-order status", pre_o["status"], "preorder")
    check("pre-order is not charged yet", pre_o["charged"], 0)
    check("pre-order waits for shipment", pre_o["charge_timing"], "at_ship")
    approx("pre-order total", pre_o["total"], 238.11)

    canc = conn.execute("SELECT * FROM orders WHERE order_no = 'PC10499001'").fetchone()
    check("cancellation recorded", canc["status"], "cancelled")

    tgt = conn.execute("SELECT * FROM orders WHERE retailer = 'Target'").fetchall()
    check("only the Pokemon Target order came through", len(tgt), 1)
    check("Target order number", tgt[0]["order_no"], "3021445907621")

    print("\n[5] Cash-due timeline")
    buckets, unscheduled = money.due_breakdown(conn)
    by_date = {b["date"]: b["amount"] for b in buckets}
    check("release dates on the calendar", sorted(by_date), ["2026-09-26", "2026-10-17"])
    # PC10502991: 179.97 mega evolution + 39.99 charizard + 18.15 tax, all on 9/26
    # plus Target 3021445907621: 108.73 mega evolution, also 9/26
    approx("owed on Sep 26 (two stores, one release)", by_date["2026-09-26"], 346.84)
    approx("owed on Oct 17", by_date["2026-10-17"], 175.30)
    approx("nothing left undated", unscheduled["amount"], 0.0)

    k = money.kpis(conn)
    approx("total still owed", k["outstanding"], 522.14)
    approx("total already charged", k["charged"], 309.85)
    check("pre-order count", k["preorders"], 2)
    check("next charge date", k["next_date"], "2026-09-26")

    print("\n[6] Release-date changes flow through")
    rel = conn.execute("SELECT * FROM releases WHERE match_text = 'destined rivals'").fetchone()
    db.update(conn, "releases", rel["id"], dict(release_date="2026-11-07"))
    conn.commit()
    by_date2 = {b["date"]: b["amount"] for b in money.due_breakdown(conn)[0]}
    check("moving a release moves the money", sorted(by_date2),
          ["2026-09-26", "2026-11-07"])
    db.update(conn, "releases", rel["id"], dict(release_date="2026-10-17"))
    conn.commit()

    print("\n[7] Hand edits survive a rebuild")
    db.update(conn, "orders", pre_o["id"],
              dict(total=999.00, locked='["total"]', notes="checked by hand"))
    conn.commit()
    mailscan.rebuild(conn)
    after = conn.execute("SELECT * FROM orders WHERE order_no = 'PC10502991'").fetchone()
    approx("edited total was not overwritten", after["total"], 999.00)
    check("notes survived", after["notes"], "checked by hand")
    n_orders = conn.execute("SELECT COUNT(*) c FROM orders").fetchone()["c"]
    check("no duplicate orders after rebuild", n_orders, 6)
    db.update(conn, "orders", pre_o["id"], dict(total=238.11, locked="[]", notes=""))
    conn.commit()

    print("\n[8] Every page renders")
    pages = [
        ("dashboard", lambda: views.dashboard(conn)),
        ("orders", lambda: views.orders_page(conn, {})),
        ("orders filtered", lambda: views.orders_page(conn, dict(status="preorder", q="mega"))),
        ("order detail", lambda: views.order_detail(conn, pre_o["id"])),
        ("new order", views.new_order_form),
        ("releases", lambda: views.releases_page(conn)),
        ("releases edit", lambda: views.releases_page(conn, rel["id"])),
        ("rules", lambda: views.rules_page(conn)),
        ("rule edit", lambda: views.rule_form(conn, 1)),
        ("rule new", lambda: views.rule_form(conn)),
        ("rule tester", lambda: views.rule_tester(conn)),
        ("review", lambda: views.review_page(conn)),
        ("email", lambda: views.email_page(conn, 2)),
        ("accounts", lambda: views.accounts_page(conn)),
    ]
    for name, fn in pages:
        try:
            html = fn()
            ok = bool(html) and len(html) > 200
        except Exception as exc:
            ok = False
            print("      %s raised %s: %s" % (name, type(exc).__name__, exc))
            import traceback; traceback.print_exc()
        check("%s page renders" % name, ok, True)
        if ok:
            full = views.layout(name, html, "/")
            check("  %s wraps in layout" % name, full.count("<html") == 1, True)

    print("\n[9] Rule tester")
    rule_rows = conn.execute("SELECT * FROM rules ORDER BY priority, id").fetchall()
    sample = dict(from_addr="orders@pokemoncenter.com", from_name="Pokemon Center",
                  subject="Your pre-order is confirmed",
                  body=parser.html_to_text(samples.PC_PREORDER_HTML))
    winner = rules.pick(rule_rows, sample)
    parsed = parser.parse(sample, winner)
    check("tester finds the winner", winner["name"], "Pokemon Center pre-orders")
    check("tester extracts the order number", parsed["order_no"], "PC10502991")
    checks = [(r, rules.check(r, sample)) for r in rule_rows]
    html = views.tester_result(conn, sample, winner, parsed, checks)
    check("tester result renders", len(html) > 500, True)

    print("\n" + "=" * 60)
    if FAIL:
        print("%d FAILURE(S): %s" % (len(FAIL), ", ".join(FAIL)))
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

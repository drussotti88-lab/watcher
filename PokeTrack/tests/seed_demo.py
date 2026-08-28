"""Fill the database with the sample orders so you can see the dashboard working.

Run:  python tests/seed_demo.py
Undo: delete the data folder.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from poketrack import db, mailscan, parser  # noqa: E402
import samples  # noqa: E402


def main():
    conn = db.init()
    if conn.execute("SELECT COUNT(*) c FROM emails").fetchone()["c"]:
        print("There is already data here. Delete the data folder first if you "
              "want a clean demo.")
        return 1
    db.insert(conn, "accounts", dict(
        label="Demo inbox", email="demo@example.com", imap_host="imap.example.com",
        imap_port=993, secret="", folder="INBOX", enabled=0,
        last_status="demo data — not a real inbox"))
    for i, (subject, addr, name, when, html) in enumerate(samples.SAMPLES):
        db.insert(conn, "emails", dict(
            account_id=1, message_id="<demo-%d@test>" % i, subject=subject,
            from_addr=addr, from_name=name, received_at=when,
            body=parser.html_to_text(html), status="new"))
    for product, date, match, price, retailer in samples.RELEASES:
        db.insert(conn, "releases", dict(
            product=product, release_date=date, match_text=match,
            est_price=price, retailer=retailer, notes=""))
    conn.commit()
    stats = mailscan.apply_rules(conn, only_new=True)
    print("Demo data loaded: %(orders)d orders from %(matched)d matched emails." % stats)
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Read mail over IMAP and turn matching messages into orders."""
import email as emaillib
import email.utils
import imaplib
import re
import socket
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header

from . import crypto, db, parser, rules

imaplib._MAXLINE = 10_000_000

KNOWN_HOSTS = {
    "gmail.com": "imap.gmail.com",
    "googlemail.com": "imap.gmail.com",
    "outlook.com": "outlook.office365.com",
    "hotmail.com": "outlook.office365.com",
    "live.com": "outlook.office365.com",
    "msn.com": "outlook.office365.com",
    "yahoo.com": "imap.mail.yahoo.com",
    "ymail.com": "imap.mail.yahoo.com",
    "aol.com": "imap.aol.com",
    "icloud.com": "imap.mail.me.com",
    "me.com": "imap.mail.me.com",
    "mac.com": "imap.mail.me.com",
    "fastmail.com": "imap.fastmail.com",
    "zoho.com": "imap.zoho.com",
    "gmx.com": "imap.gmx.com",
}


def guess_host(address):
    domain = (address or "").split("@")[-1].strip().lower()
    return KNOWN_HOSTS.get(domain, "imap." + domain if domain else "")


def _decode(value):
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value))).strip()
    except Exception:
        return str(value).strip()


def _body_of(msg):
    """Prefer text/plain; fall back to flattened HTML."""
    plain, html = [], []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_maintype() == "multipart":
                continue
            disp = str(part.get("Content-Disposition") or "")
            if "attachment" in disp.lower():
                continue
            ctype = part.get_content_type()
            if ctype not in ("text/plain", "text/html"):
                continue
            try:
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                text = payload.decode(charset, errors="replace")
            except Exception:
                continue
            (plain if ctype == "text/plain" else html).append(text)
    else:
        try:
            payload = msg.get_payload(decode=True) or b""
            text = payload.decode(msg.get_content_charset() or "utf-8", errors="replace")
        except Exception:
            text = ""
        (html if msg.get_content_type() == "text/html" else plain).append(text)

    plain_text = "\n".join(plain).strip()
    html_text = parser.html_to_text("\n".join(html)) if html else ""
    # Marketing mail often has a near-empty plain part, so take the richer one.
    if len(html_text) > len(plain_text) * 1.2:
        return html_text
    return plain_text or html_text


def _received_at(msg):
    raw = msg.get("Date")
    try:
        dt = email.utils.parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat(timespec="seconds")
    except Exception:
        return db.utcnow()


def test_connection(host, port, address, password, folder="INBOX"):
    try:
        box = imaplib.IMAP4_SSL(host, int(port), timeout=30)
    except (socket.gaierror, socket.timeout, OSError) as exc:
        return False, "Could not reach %s:%s (%s)" % (host, port, exc)
    try:
        box.login(address, password)
    except imaplib.IMAP4.error as exc:
        detail = str(exc)
        hint = ""
        if "AUTHENTICATIONFAILED" in detail.upper() or "invalid credentials" in detail.lower():
            hint = (" -- most providers reject your normal password here. "
                    "You need an app password with 2-step verification turned on.")
        return False, "Login refused: %s%s" % (detail[:200], hint)
    try:
        status, _ = box.select(folder, readonly=True)
        if status != "OK":
            return False, "Signed in, but the folder %r was not found." % folder
    finally:
        try:
            box.logout()
        except Exception:
            pass
    return True, "Connected successfully."


def fetch_account(conn, account, senders, limit=400):
    """Download new messages from one mailbox. Returns (new_count, message)."""
    password = crypto.decrypt(account["secret"])
    host, port = account["imap_host"], int(account["imap_port"])
    try:
        box = imaplib.IMAP4_SSL(host, port, timeout=45)
        box.login(account["email"], password)
        status, _ = box.select(account["folder"], readonly=True)
        if status != "OK":
            raise imaplib.IMAP4.error("folder %r not found" % account["folder"])
    except Exception as exc:
        return 0, "Could not open %s: %s" % (account["email"], str(exc)[:200])

    since = (datetime.now(timezone.utc)
             - timedelta(days=int(account["since_days"] or 540))).strftime("%d-%b-%Y")

    uids = []
    try:
        # One search per sender fragment, then union -- far more portable than
        # trying to build a single nested IMAP OR expression.
        criteria = ([("SINCE", since, "FROM", '"%s"' % s) for s in senders]
                    or [("SINCE", since)])
        for crit in criteria:
            try:
                status, data = box.uid("SEARCH", None, *crit)
            except imaplib.IMAP4.error:
                continue
            if status == "OK" and data and data[0]:
                uids.extend(data[0].split())
        uids = list(dict.fromkeys(uids))[-limit:]

        known = {r["message_id"] for r in conn.execute(
            "SELECT message_id FROM emails WHERE account_id = ?", (account["id"],))}

        new = 0
        for uid in uids:
            try:
                status, data = box.uid("FETCH", uid, "(RFC822)")
            except imaplib.IMAP4.error:
                continue
            if status != "OK" or not data or not isinstance(data[0], tuple):
                continue
            msg = emaillib.message_from_bytes(data[0][1])
            message_id = (msg.get("Message-ID") or "").strip() or "uid-%s" % uid.decode()
            if message_id in known:
                continue
            known.add(message_id)
            name, addr = email.utils.parseaddr(msg.get("From") or "")
            db.insert(conn, "emails", dict(
                account_id=account["id"],
                message_id=message_id,
                subject=_decode(msg.get("Subject")),
                from_addr=addr.lower(),
                from_name=_decode(name),
                received_at=_received_at(msg),
                body=_body_of(msg)[:200_000],
                status="new",
            ))
            new += 1
        conn.commit()
        return new, "%s: %d new message(s) from %d matching" % (
            account["email"], new, len(uids))
    finally:
        try:
            box.logout()
        except Exception:
            pass


# --------------------------------------------------------------------------
# Turning stored emails into orders
# --------------------------------------------------------------------------

def _as_dict(row):
    return {k: row[k] for k in row.keys()}


def apply_rules(conn, only_new=True):
    """Match stored emails against rules and build/refresh orders."""
    rule_rows = conn.execute("SELECT * FROM rules").fetchall()
    if not rule_rows:
        return dict(matched=0, ignored=0, review=0, orders=0)

    where = "WHERE status = 'new'" if only_new else ""
    emails = conn.execute(
        "SELECT * FROM emails %s ORDER BY received_at ASC, id ASC" % where).fetchall()

    stats = dict(matched=0, ignored=0, review=0, orders=0)
    for row in emails:
        e = _as_dict(row)
        rule = rules.pick(rule_rows, e)
        if not rule:
            db.update(conn, "emails", e["id"],
                      dict(status="ignored", rule_id=None, note="No rule matched"))
            stats["ignored"] += 1
            continue

        parsed = parser.parse(e, rule)
        stats["matched"] += 1
        conn.execute("UPDATE rules SET hits = hits + 1 WHERE id = ?", (rule["id"],))

        if not parsed["order_no"]:
            db.update(conn, "emails", e["id"], dict(
                status="needs_review", rule_id=rule["id"],
                note="Matched %r but %s" % (rule["name"], "; ".join(parsed["problems"]))))
            stats["review"] += 1
            continue

        order_id, created = _upsert_order(conn, e, rule, parsed)
        stats["orders"] += created
        db.update(conn, "emails", e["id"], dict(
            status="needs_review" if parsed["problems"] else "parsed",
            rule_id=rule["id"], order_id=order_id,
            note="; ".join(parsed["problems"])))
        if parsed["problems"]:
            stats["review"] += 1
    conn.commit()
    return stats


def _upsert_order(conn, e, rule, parsed):
    retailer = parsed["retailer"] or "Unknown"
    existing = conn.execute(
        "SELECT * FROM orders WHERE retailer = ? AND order_no = ?",
        (retailer, parsed["order_no"])).fetchone()

    email_date = (e["received_at"] or db.utcnow())[:10]
    kind = parsed["kind"]

    if existing is None:
        fields = dict(
            order_no=parsed["order_no"], retailer=retailer, account_id=e["account_id"],
            order_date=email_date, status=parsed["status"], total=parsed["total"],
            currency=parsed["currency"], charge_timing=parsed["charge_timing"],
            tracking=parsed["tracking"], tag=parsed["tag"], rule_id=rule["id"],
            created_at=db.utcnow(), updated_at=db.utcnow(),
        )
        fields.update(_charge_state(fields, email_date))
        order_id = db.insert(conn, "orders", fields)
        _replace_items(conn, order_id, parsed["items"])
        return order_id, 1

    order_id = existing["id"]
    locked = db.locked_fields(existing)
    changes = {}

    def maybe(field, value):
        if field not in locked and value not in (None, "", 0):
            changes[field] = value

    if kind == "cancellation":
        maybe("status", "cancelled")
        if "charged" not in locked:
            changes["charged"] = 0
            changes["charge_date"] = None
    elif kind == "delivery":
        maybe("status", "delivered")
    elif kind == "shipment":
        if existing["status"] not in ("cancelled",):
            maybe("status", "shipped")
        maybe("tracking", parsed["tracking"])
        if "charged" not in locked and existing["charge_timing"] != "at_order":
            changes["charged"] = 1
            changes["charge_date"] = email_date
    else:
        if existing["status"] in ("open",) and kind == "preorder":
            maybe("status", "preorder")
        if not existing["total"]:
            maybe("total", parsed["total"])
        maybe("tag", parsed["tag"])
        if not conn.execute("SELECT 1 FROM items WHERE order_id = ?",
                            (order_id,)).fetchone():
            _replace_items(conn, order_id, parsed["items"])

    if changes:
        changes["updated_at"] = db.utcnow()
        db.update(conn, "orders", order_id, changes)
    return order_id, 0


def _charge_state(fields, email_date):
    """A brand-new order: has the card actually been hit yet?"""
    if fields["status"] == "cancelled":
        return dict(charged=0, charge_date=None)
    if fields["charge_timing"] == "at_order":
        return dict(charged=1, charge_date=fields["order_date"])
    if fields["status"] in ("shipped", "delivered"):
        return dict(charged=1, charge_date=email_date)
    return dict(charged=0, charge_date=None)


def _replace_items(conn, order_id, items):
    conn.execute("DELETE FROM items WHERE order_id = ? AND manual = 0", (order_id,))
    for it in items:
        db.insert(conn, "items", dict(order_id=order_id, **it))


def rebuild(conn):
    """Re-run every stored email through the current rules.

    Orders you edited by hand, added notes to, or created yourself are kept.
    """
    conn.execute("""
        DELETE FROM items WHERE order_id IN (
            SELECT id FROM orders WHERE locked = '[]' AND notes = '' AND rule_id IS NOT NULL
        ) AND manual = 0""")
    conn.execute("""
        DELETE FROM orders
        WHERE locked = '[]' AND notes = '' AND rule_id IS NOT NULL
          AND id NOT IN (SELECT DISTINCT order_id FROM items WHERE manual = 1)""")
    conn.execute("UPDATE emails SET status = 'new', order_id = NULL, note = ''")
    conn.execute("UPDATE rules SET hits = 0")
    conn.commit()
    stats = apply_rules(conn, only_new=False)
    db.log(conn, "rebuild", "Re-applied rules: %(matched)d matched, %(orders)d new orders, "
                            "%(review)d need review, %(ignored)d ignored" % stats)
    conn.commit()
    return stats


def scan_all(conn):
    accounts = conn.execute("SELECT * FROM accounts WHERE enabled = 1").fetchall()
    if not accounts:
        return "No email accounts are set up yet."
    rule_rows = conn.execute("SELECT * FROM rules").fetchall()
    senders = rules.imap_senders(rule_rows)
    messages, total_new = [], 0
    for acct in accounts:
        new, msg = fetch_account(conn, acct, senders)
        total_new += new
        messages.append(msg)
        db.update(conn, "accounts", acct["id"],
                  dict(last_scan_at=db.utcnow(), last_status=msg[:300]))
        conn.commit()
    stats = apply_rules(conn, only_new=True)
    summary = "%d new email(s). %d matched a rule, %d new order(s), %d need review." % (
        total_new, stats["matched"], stats["orders"], stats["review"])
    db.log(conn, "scan", summary + " | " + " | ".join(messages))
    conn.commit()
    return summary

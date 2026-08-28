"""A tiny web server built on Python's standard library. No frameworks."""
import json
import mimetypes
import os
import re
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

from . import crypto, db, mailscan, money, parser, rules as rules_mod, views

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

SCAN = dict(running=False, message="")
_scan_lock = threading.Lock()
_db_lock = threading.Lock()


def _flash(path, message, bad=False):
    sep = "&" if "?" in path else "?"
    return "%s%smsg=%s%s" % (path, sep, quote(message), "&bad=1" if bad else "")


class Handler(BaseHTTPRequestHandler):
    server_version = "PokeTrack"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # keep the console quiet

    # -------------------------------------------------------------- plumbing
    def _send(self, body, code=200, ctype="text/html; charset=utf-8", headers=None):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _redirect(self, path):
        self.send_response(303)
        self.send_header("Location", path)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _page(self, title, body, active, q):
        conn = self.server.conn
        review = conn.execute(
            "SELECT COUNT(*) c FROM emails WHERE status = 'needs_review'").fetchone()["c"]
        self._send(views.layout(
            title, body, active,
            flash=q.get("msg", [None])[0], flash_bad=bool(q.get("bad")),
            review_count=review, scanning=SCAN["running"]))

    def _form(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", errors="replace") if length else ""
        return {k: v[0] for k, v in parse_qs(raw, keep_blank_values=True).items()}

    def _static(self, name):
        safe = os.path.normpath(name).lstrip("/\\")
        path = os.path.join(STATIC_DIR, safe)
        if not path.startswith(STATIC_DIR) or not os.path.isfile(path):
            return self._send("Not found", 404, "text/plain")
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as fh:
            self._send(fh.read(), 200, ctype)

    # ------------------------------------------------------------------- GET
    def do_GET(self):
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        q = parse_qs(url.query, keep_blank_values=True)
        flat = {k: v[0] for k, v in q.items()}
        conn = self.server.conn
        try:
            if path.startswith("/static/"):
                return self._static(path[len("/static/"):])
            if path == "/scan/status":
                return self._send(json.dumps(SCAN), 200, "application/json")

            if path == "/":
                with _db_lock:
                    body = views.dashboard(conn)
                return self._page("Dashboard", body, "/", q)

            if path == "/orders":
                with _db_lock:
                    body = views.orders_page(conn, flat)
                return self._page("Orders", body, "/orders", q)

            if path == "/orders/new":
                return self._page("Add order", views.new_order_form(), "/orders", q)

            m = re.fullmatch(r"/orders/(\d+)", path)
            if m:
                with _db_lock:
                    body = views.order_detail(conn, int(m.group(1)))
                if body is None:
                    return self._send("Order not found", 404, "text/plain")
                return self._page("Order", body, "/orders", q)

            if path == "/releases":
                edit = flat.get("edit")
                with _db_lock:
                    body = views.releases_page(conn, int(edit) if edit else None)
                return self._page("Release dates", body, "/releases", q)

            if path == "/rules":
                with _db_lock:
                    body = views.rules_page(conn)
                return self._page("Rules", body, "/rules", q)

            if path == "/rules/new":
                return self._page("New rule", views.rule_form(conn), "/rules", q)

            if path == "/rules/test":
                sample = None
                result = None
                if flat.get("email_id"):
                    sample, result = self._run_test(conn, dict(email_id=flat["email_id"]))
                return self._page("Test a rule",
                                  views.rule_tester(conn, sample, result), "/rules", q)

            m = re.fullmatch(r"/rules/(\d+)", path)
            if m:
                body = views.rule_form(conn, int(m.group(1)))
                if body is None:
                    return self._send("Rule not found", 404, "text/plain")
                return self._page("Edit rule", body, "/rules", q)

            if path == "/review":
                with _db_lock:
                    body = views.review_page(conn)
                return self._page("Needs review", body, "/review", q)

            m = re.fullmatch(r"/email/(\d+)", path)
            if m:
                with _db_lock:
                    body = views.email_page(conn, int(m.group(1)))
                if body is None:
                    return self._send("Email not found", 404, "text/plain")
                return self._page("Email", body, "/review", q)

            if path == "/accounts":
                with _db_lock:
                    body = views.accounts_page(conn)
                return self._page("Email accounts", body, "/accounts", q)

            self._send("Not found", 404, "text/plain")
        except Exception:
            self._oops()

    # ------------------------------------------------------------------ POST
    def do_POST(self):
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        form = self._form()
        conn = self.server.conn
        try:
            if path == "/scan":
                return self._redirect(self._start_scan())

            if path == "/rebuild":
                with _db_lock:
                    stats = mailscan.rebuild(conn)
                return self._redirect(_flash(
                    "/rules", "Rebuilt: %(matched)d email(s) matched, %(orders)d order(s), "
                              "%(review)d need review." % stats))

            if path == "/accounts":
                return self._redirect(self._save_account(conn, form))

            m = re.fullmatch(r"/accounts/(\d+)/delete", path)
            if m:
                with _db_lock:
                    conn.execute("DELETE FROM accounts WHERE id = ?", (int(m.group(1)),))
                    conn.commit()
                return self._redirect(_flash("/accounts", "Inbox removed."))

            if path == "/rules/new":
                with _db_lock:
                    rid = db.insert(conn, "rules",
                                    dict(_rule_fields(form), created_at=db.utcnow()))
                    conn.commit()
                return self._redirect(_flash("/rules/%d" % rid, "Rule created. "
                                             "Re-apply rules to see it take effect."))

            m = re.fullmatch(r"/rules/(\d+)", path)
            if m:
                with _db_lock:
                    db.update(conn, "rules", int(m.group(1)), _rule_fields(form))
                    conn.commit()
                return self._redirect(_flash("/rules", "Rule saved. "
                                             "Re-apply rules to rebuild your orders."))

            m = re.fullmatch(r"/rules/(\d+)/delete", path)
            if m:
                with _db_lock:
                    conn.execute("DELETE FROM rules WHERE id = ?", (int(m.group(1)),))
                    conn.commit()
                return self._redirect(_flash("/rules", "Rule deleted."))

            if path == "/rules/test":
                sample, result = self._run_test(conn, form)
                return self._page("Test a rule",
                                  views.rule_tester(conn, sample, result), "/rules", {})

            if path == "/releases":
                return self._redirect(self._save_release(conn, form))

            m = re.fullmatch(r"/releases/(\d+)/delete", path)
            if m:
                with _db_lock:
                    conn.execute("DELETE FROM releases WHERE id = ?", (int(m.group(1)),))
                    conn.commit()
                return self._redirect(_flash("/releases", "Release date deleted."))

            if path == "/orders/new":
                with _db_lock:
                    fields = _order_fields(form)
                    fields.update(created_at=db.utcnow(), updated_at=db.utcnow(),
                                  locked=json.dumps(["manual"]))
                    try:
                        oid = db.insert(conn, "orders", fields)
                    except Exception:
                        conn.rollback()
                        return self._redirect(_flash(
                            "/orders/new", "An order with that number already exists.", True))
                    conn.commit()
                return self._redirect(_flash("/orders/%d" % oid, "Order created."))

            m = re.fullmatch(r"/orders/(\d+)", path)
            if m:
                return self._redirect(self._save_order(conn, int(m.group(1)), form))

            m = re.fullmatch(r"/orders/(\d+)/item", path)
            if m:
                oid = int(m.group(1))
                qty = max(1, int(form.get("qty") or 1))
                price = parser.money(form.get("unit_price"))
                with _db_lock:
                    db.insert(conn, "items", dict(
                        order_id=oid, name=(form.get("name") or "").strip()[:200],
                        qty=qty, unit_price=price,
                        line_total=round(qty * price, 2), manual=1))
                    conn.commit()
                return self._redirect(_flash("/orders/%d" % oid, "Line item added."))

            self._send("Not found", 404, "text/plain")
        except Exception:
            self._oops()

    # ----------------------------------------------------------- form actions
    def _start_scan(self):
        with _scan_lock:
            if SCAN["running"]:
                return _flash("/", "A scan is already running.")
            SCAN["running"] = True
            SCAN["message"] = ""

        def work():
            conn = db.connect()
            try:
                with _db_lock:
                    SCAN["message"] = mailscan.scan_all(conn)
            except Exception as exc:
                SCAN["message"] = "Scan failed: %s" % str(exc)[:250]
                traceback.print_exc()
            finally:
                conn.close()
                SCAN["running"] = False

        threading.Thread(target=work, daemon=True).start()
        return "/"

    def _save_account(self, conn, form):
        address = (form.get("email") or "").strip().lower()
        password = form.get("password") or ""
        host = (form.get("imap_host") or "").strip() or mailscan.guess_host(address)
        folder = (form.get("folder") or "INBOX").strip() or "INBOX"
        if not address or not password:
            return _flash("/accounts", "Email address and app password are both required.", True)
        if not host:
            return _flash("/accounts", "Could not work out the IMAP server — type it in.", True)

        ok, message = mailscan.test_connection(host, 993, address, password, folder)
        if not ok:
            return _flash("/accounts", message, True)
        if form.get("action") == "test":
            return _flash("/accounts", message + " Hit “Save inbox” to keep it.")

        with _db_lock:
            existing = conn.execute("SELECT id FROM accounts WHERE email = ?",
                                    (address,)).fetchone()
            fields = dict(
                label=(form.get("label") or "").strip() or address,
                email=address, imap_host=host, imap_port=993,
                secret=crypto.encrypt(password), folder=folder, enabled=1,
                since_days=int(form.get("since_days") or 540))
            if existing:
                db.update(conn, "accounts", existing["id"], fields)
            else:
                db.insert(conn, "accounts", fields)
            conn.commit()
        return _flash("/accounts", "Saved. Hit “Scan my email” to pull your orders in.")

    def _save_release(self, conn, form):
        product = (form.get("product") or "").strip()
        date = (form.get("release_date") or "").strip()
        if not product or not date:
            return _flash("/releases", "Product and release date are both required.", True)
        fields = dict(product=product[:200], release_date=date[:10],
                      match_text=(form.get("match_text") or "").strip()[:300],
                      est_price=parser.money(form.get("est_price")),
                      retailer=(form.get("retailer") or "").strip()[:80],
                      notes=(form.get("notes") or "").strip()[:400])
        with _db_lock:
            if form.get("id"):
                db.update(conn, "releases", int(form["id"]), fields)
                msg = "Release date updated."
            else:
                db.insert(conn, "releases", fields)
                msg = "Release date added — it is on the timeline now."
            conn.commit()
        return _flash("/releases", msg)

    def _save_order(self, conn, order_id, form):
        with _db_lock:
            before = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
            if not before:
                return _flash("/orders", "That order no longer exists.", True)
            fields = _order_fields(form)
            locked = db.locked_fields(before)
            for key, value in fields.items():
                if str(before[key] or "") != str(value or ""):
                    locked.add(key)
            fields["locked"] = json.dumps(sorted(locked))
            fields["updated_at"] = db.utcnow()
            db.update(conn, "orders", order_id, fields)
            conn.commit()
        return _flash("/orders/%d" % order_id, "Saved. These fields are now protected "
                                               "from being overwritten by a rescan.")

    def _run_test(self, conn, form):
        if form.get("email_id"):
            row = conn.execute("SELECT * FROM emails WHERE id = ?",
                               (int(form["email_id"]),)).fetchone()
            if row:
                sample = dict(id=row["id"], from_addr=row["from_addr"],
                              from_name=row["from_name"], subject=row["subject"],
                              body=row["body"])
            else:
                sample = dict(from_addr="", subject="", body="")
        else:
            sample = dict(from_addr=(form.get("from_addr") or "").strip(), from_name="",
                          subject=form.get("subject") or "", body=form.get("body") or "")
        if not any([sample["from_addr"], sample["subject"], sample["body"]]):
            return sample, None

        rule_rows = conn.execute("SELECT * FROM rules ORDER BY priority, id").fetchall()
        winner = rules_mod.pick(rule_rows, sample)
        parsed = parser.parse(sample, winner) if winner else None
        checks = [(r, rules_mod.check(r, sample)) for r in rule_rows]
        return sample, views.tester_result(conn, sample, winner, parsed, checks)

    def _oops(self):
        traceback.print_exc()
        self._send("<h1>Something went wrong</h1><pre>%s</pre>"
                   "<p><a href='/'>Back to the dashboard</a></p>"
                   % traceback.format_exc(), 500)


def _rule_fields(form):
    def s(key, limit=400):
        return (form.get(key) or "").strip()[:limit]
    kind = s("kind") if s("kind") in rules_mod.KINDS else "auto"
    timing = s("charge_timing") if s("charge_timing") in rules_mod.TIMINGS else "auto"
    try:
        priority = int(form.get("priority") or 100)
    except ValueError:
        priority = 100
    return dict(
        name=s("name", 120) or "Untitled rule", enabled=1 if form.get("enabled") else 0,
        priority=priority, retailer=s("retailer", 80),
        from_contains=s("from_contains"), subject_contains=s("subject_contains"),
        subject_excludes=s("subject_excludes"), body_contains=s("body_contains"),
        use_regex=1 if form.get("use_regex") else 0, kind=kind, charge_timing=timing,
        order_no_regex=s("order_no_regex"), total_regex=s("total_regex"),
        item_regex=s("item_regex"), tag=s("tag", 80), notes=s("notes", 1000))


def _order_fields(form):
    def s(key, limit=200):
        return (form.get(key) or "").strip()[:limit]
    status = s("status") if s("status") in views.STATUS_LABEL else "open"
    timing = s("charge_timing") if s("charge_timing") in rules_mod.TIMINGS else "at_ship"
    return dict(
        order_no=s("order_no", 40) or "?", retailer=s("retailer", 80),
        order_date=s("order_date", 10) or money.today(), status=status,
        total=parser.money(form.get("total")), charge_timing=timing,
        charged=1 if form.get("charged") == "1" else 0,
        charge_date=s("charge_date", 10) or None,
        release_date=s("release_date", 10) or None,
        tracking=s("tracking", 60), tag=s("tag", 80), notes=s("notes", 2000))


def serve(host="127.0.0.1", port=8765):
    conn = db.init()
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.conn = conn
    httpd.daemon_threads = True
    return httpd

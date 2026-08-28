"""SQLite storage layer for PokeTrack."""
import json
import os
import sqlite3
from datetime import datetime, timezone

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(APP_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "poketrack.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id           INTEGER PRIMARY KEY,
    label        TEXT NOT NULL,
    email        TEXT NOT NULL UNIQUE,
    imap_host    TEXT NOT NULL,
    imap_port    INTEGER NOT NULL DEFAULT 993,
    secret       TEXT NOT NULL,
    folder       TEXT NOT NULL DEFAULT 'INBOX',
    enabled      INTEGER NOT NULL DEFAULT 1,
    since_days   INTEGER NOT NULL DEFAULT 540,
    last_scan_at TEXT,
    last_status  TEXT
);

CREATE TABLE IF NOT EXISTS rules (
    id               INTEGER PRIMARY KEY,
    name             TEXT NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    priority         INTEGER NOT NULL DEFAULT 100,
    retailer         TEXT NOT NULL DEFAULT '',
    from_contains    TEXT NOT NULL DEFAULT '',
    subject_contains TEXT NOT NULL DEFAULT '',
    subject_excludes TEXT NOT NULL DEFAULT '',
    body_contains    TEXT NOT NULL DEFAULT '',
    use_regex        INTEGER NOT NULL DEFAULT 0,
    kind             TEXT NOT NULL DEFAULT 'auto',
    charge_timing    TEXT NOT NULL DEFAULT 'auto',
    order_no_regex   TEXT NOT NULL DEFAULT '',
    total_regex      TEXT NOT NULL DEFAULT '',
    item_regex       TEXT NOT NULL DEFAULT '',
    currency         TEXT NOT NULL DEFAULT 'USD',
    tag              TEXT NOT NULL DEFAULT '',
    notes            TEXT NOT NULL DEFAULT '',
    hits             INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT
);

CREATE TABLE IF NOT EXISTS emails (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER,
    message_id  TEXT,
    subject     TEXT NOT NULL DEFAULT '',
    from_addr   TEXT NOT NULL DEFAULT '',
    from_name   TEXT NOT NULL DEFAULT '',
    received_at TEXT,
    body        TEXT NOT NULL DEFAULT '',
    rule_id     INTEGER,
    status      TEXT NOT NULL DEFAULT 'new',
    note        TEXT NOT NULL DEFAULT '',
    order_id    INTEGER,
    UNIQUE(account_id, message_id)
);

CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY,
    order_no      TEXT NOT NULL,
    retailer      TEXT NOT NULL DEFAULT '',
    account_id    INTEGER,
    order_date    TEXT,
    status        TEXT NOT NULL DEFAULT 'open',
    total         REAL NOT NULL DEFAULT 0,
    currency      TEXT NOT NULL DEFAULT 'USD',
    charge_timing TEXT NOT NULL DEFAULT 'at_ship',
    charged       INTEGER NOT NULL DEFAULT 0,
    charge_date   TEXT,
    release_date  TEXT,
    tracking      TEXT NOT NULL DEFAULT '',
    tag           TEXT NOT NULL DEFAULT '',
    rule_id       INTEGER,
    locked        TEXT NOT NULL DEFAULT '[]',
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT,
    updated_at    TEXT,
    UNIQUE(retailer, order_no)
);

CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY,
    order_id   INTEGER NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    qty        INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL DEFAULT 0,
    manual     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS releases (
    id           INTEGER PRIMARY KEY,
    product      TEXT NOT NULL,
    release_date TEXT NOT NULL,
    match_text   TEXT NOT NULL DEFAULT '',
    est_price    REAL NOT NULL DEFAULT 0,
    retailer     TEXT NOT NULL DEFAULT '',
    notes        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
    id  INTEGER PRIMARY KEY,
    at  TEXT,
    kind TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_items_order  ON items(order_id);
"""

# Rules shipped out of the box. The user can edit or delete any of them.
DEFAULT_RULES = [
    dict(
        name="Pokemon Center pre-orders",
        priority=10,
        retailer="Pokemon Center",
        from_contains="pokemoncenter.com, pokemon.com",
        subject_contains="pre-order, preorder, pre order",
        kind="preorder",
        charge_timing="at_ship",
        notes="Pokemon Center authorizes at order time but charges when the item "
              "actually ships, so pre-orders count as money still owed.",
    ),
    dict(
        name="Pokemon Center orders",
        priority=20,
        retailer="Pokemon Center",
        from_contains="pokemoncenter.com, pokemon.com",
        subject_contains="order, thanks for your order, order confirmation",
        subject_excludes="cancel, shipped, delivered, refund",
        kind="order",
        charge_timing="at_order",
    ),
    dict(
        name="Pokemon Center shipping notices",
        priority=15,
        retailer="Pokemon Center",
        from_contains="pokemoncenter.com, pokemon.com",
        subject_contains="shipped, on its way, has shipped, shipment",
        kind="shipment",
        charge_timing="at_ship",
    ),
    dict(
        name="Pokemon Center cancellations",
        priority=5,
        retailer="Pokemon Center",
        from_contains="pokemoncenter.com, pokemon.com",
        subject_contains="cancel, canceled, cancelled, refund",
        kind="cancellation",
    ),
    dict(
        name="Target Pokemon orders",
        priority=30,
        retailer="Target",
        from_contains="target.com, oes.target.com",
        subject_contains="order, thanks for your order",
        subject_excludes="cancel, delivered, return",
        body_contains="pokemon, pokémon",
        kind="auto",
        charge_timing="at_ship",
        notes="Only picks up Target orders that actually mention Pokemon in the body.",
    ),
]


def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect():
    os.makedirs(DATA_DIR, exist_ok=True)
    # The web server answers requests on worker threads; every write goes
    # through a single lock in web.py, so sharing one connection is safe.
    conn = sqlite3.connect(DB_PATH, timeout=20, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init():
    conn = connect()
    conn.executescript(SCHEMA)
    conn.commit()
    if conn.execute("SELECT COUNT(*) c FROM rules").fetchone()["c"] == 0:
        for r in DEFAULT_RULES:
            insert(conn, "rules", dict(r, created_at=utcnow()))
        conn.commit()
        log(conn, "setup", "Created %d starter rules" % len(DEFAULT_RULES))
        conn.commit()
    return conn


def insert(conn, table, data):
    cols = ", ".join(data)
    marks = ", ".join("?" for _ in data)
    cur = conn.execute(
        "INSERT INTO %s (%s) VALUES (%s)" % (table, cols, marks), list(data.values())
    )
    return cur.lastrowid


def update(conn, table, row_id, data):
    if not data:
        return
    sets = ", ".join("%s = ?" % k for k in data)
    conn.execute(
        "UPDATE %s SET %s WHERE id = ?" % (table, sets), list(data.values()) + [row_id]
    )


def log(conn, kind, message):
    insert(conn, "events", dict(at=utcnow(), kind=kind, message=message))


def get_setting(conn, key, default=""):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn, key, value):
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )


def locked_fields(row):
    try:
        return set(json.loads(row["locked"] or "[]"))
    except Exception:
        return set()

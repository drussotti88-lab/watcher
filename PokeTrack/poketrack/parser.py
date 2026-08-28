"""Pull order details out of a retailer email.

Nothing here is guaranteed -- retailers change their templates constantly. Any
email the parser is unsure about is flagged for review instead of guessed at,
and every field can be corrected by hand in the app.
"""
import re
from html.parser import HTMLParser

MONEY = r"[\d][\d,]*\.\d{2}"

TOTAL_PATTERNS = [
    r"(?:order\s+total|grand\s+total|total\s+charged|amount\s+charged|"
    r"total\s+for\s+this\s+order|order\s+summary\s+total)\b[^\d$]{0,60}\$?\s*(" + MONEY + r")",
    r"\btotal\b[^\d$]{0,40}\$?\s*(" + MONEY + r")",
    r"\$\s*(" + MONEY + r")\s*$",
]

ORDER_NO_PATTERNS = [
    r"order\s*(?:#|no\.?|number|id)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{5,24})",
    r"(?:order|confirmation)\s*[:#]\s*([A-Z0-9][A-Z0-9\-]{5,24})",
    r"#\s*([0-9]{7,20})\b",
]

TRACKING_PATTERNS = [
    r"\b(1Z[0-9A-Z]{16})\b",
    r"tracking\s*(?:#|number|no\.?)?\s*[:#]?\s*([0-9A-Z]{10,30})\b",
]

KIND_KEYWORDS = [
    ("cancellation", ["cancel", "canceled", "cancelled", "refund", "we could not", "unable to fulfill"]),
    ("delivery", ["delivered", "was delivered", "your package arrived"]),
    ("shipment", ["has shipped", "have shipped", "on its way", "shipping confirmation",
                  "shipped", "out for delivery", "tracking number"]),
    ("preorder", ["pre-order", "preorder", "pre order", "reserved for you",
                  "will be charged when", "ships on", "available on"]),
    ("order", ["order confirmation", "thanks for your order", "thank you for your order",
               "we received your order", "order received", "your order"]),
]

STATUS_BY_KIND = {
    "order": "open",
    "preorder": "preorder",
    "shipment": "shipped",
    "delivery": "delivered",
    "cancellation": "cancelled",
}

NOT_A_PRODUCT = [
    "total", "subtotal", "shipping", "tax", "discount", "estimated", "order",
    "thank", "thanks", "view ", "track", "manage", "unsubscribe", "privacy",
    "terms", "help", "contact", "sign in", "account", "http", "www.", "©",
    "copyright", "all rights", "questions", "email", "credit", "payment",
    "billing", "delivery", "address", "summary", "qty", "quantity", "price",
    "item", "promo", "gift card", "balance", "savings", "reward",
]

ITEM_LINE_PATTERNS = [
    re.compile(r"^(?P<name>\S.{2,110}?)\s{2,}(?:x\s*|qty:?\s*)?(?P<qty>\d{1,3})\s{2,}"
               r"\$?(?P<price>" + MONEY + r")\s*$"),
    re.compile(r"^(?P<name>\S.{2,110}?)\s+(?:x|qty:?)\s*(?P<qty>\d{1,3})\s+"
               r"\$(?P<price>" + MONEY + r")\s*$", re.I),
    re.compile(r"^(?P<qty>\d{1,3})\s*x\s+(?P<name>\S.{2,110}?)\s+"
               r"\$(?P<price>" + MONEY + r")\s*$", re.I),
]


class _Text(HTMLParser):
    """Flatten HTML into readable text without any third-party library."""

    SKIP = {"script", "style", "head", "title", "meta", "link"}
    BREAK = {"br", "p", "div", "tr", "table", "li", "h1", "h2", "h3", "h4", "h5",
             "h6", "section", "header", "footer", "ul", "ol"}
    CELL = {"td", "th"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skipping = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skipping += 1
        elif tag in self.BREAK:
            self.parts.append("\n")
        elif tag in self.CELL:
            self.parts.append("  ")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skipping:
            self.skipping -= 1
        elif tag in self.BREAK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skipping and data.strip():
            self.parts.append(data)


def html_to_text(html):
    p = _Text()
    try:
        p.feed(html)
        p.close()
    except Exception:
        pass
    text = "".join(p.parts)
    text = text.replace("\xa0", " ").replace("‌", "").replace("​", "")
    lines = []
    for raw in text.split("\n"):
        line = re.sub(r"[ \t]+", " ", raw).strip()
        if line or (lines and lines[-1]):
            lines.append(line)
    out = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def money(value):
    try:
        return round(float(str(value).replace(",", "").replace("$", "").strip()), 2)
    except (TypeError, ValueError):
        return 0.0


def _first_group(text, patterns, override=""):
    pats = [override] if override else patterns
    for pat in pats:
        try:
            m = re.search(pat, text, re.I | re.S)
        except re.error:
            continue
        if m:
            groups = m.groupdict()
            if "value" in groups and groups["value"]:
                return groups["value"].strip()
            return (m.group(1) if m.groups() else m.group(0)).strip()
    return ""


def extract_order_no(subject, body, override=""):
    for source in (subject, body):
        found = _first_group(source or "", ORDER_NO_PATTERNS, override)
        if found and not re.fullmatch(r"[\d\-]{1,5}", found):
            return found.upper().strip("-#: ")
    return ""


def extract_total(body, override=""):
    found = _first_group(body or "", TOTAL_PATTERNS, override)
    return money(found)


def extract_tracking(body):
    if not re.search(r"track", body or "", re.I):
        return ""
    return _first_group(body or "", TRACKING_PATTERNS)


def _looks_like_product(line):
    low = line.lower()
    if len(line) < 4 or len(line) > 120:
        return False
    if not re.search(r"[a-z]{3}", low):
        return False
    if re.fullmatch(r"[\$\d,.\s]+", line):
        return False
    return not any(bad in low for bad in NOT_A_PRODUCT)


def extract_items(body, override=""):
    """Try a few layouts. Returns [] rather than inventing line items."""
    lines = [l.rstrip() for l in (body or "").splitlines()]
    items = []

    if override:
        try:
            rx = re.compile(override, re.I | re.M)
        except re.error:
            rx = None
        if rx:
            for m in rx.finditer(body or ""):
                g = m.groupdict()
                name = (g.get("name") or "").strip()
                if name:
                    qty = int(g.get("qty") or 1)
                    price = money(g.get("price") or 0)
                    items.append(_item(name, qty, price))
            if items:
                return items

    for pattern in ITEM_LINE_PATTERNS:
        for line in lines:
            m = pattern.match(line.strip())
            if m and _looks_like_product(m.group("name")):
                items.append(_item(m.group("name").strip(),
                                   int(m.group("qty")), money(m.group("price"))))
        if items:
            return items

    # Layout where the product name, quantity and price each sit on their own
    # line -- what an HTML order table usually flattens into.
    pending, qty = None, 1
    price_only = re.compile(r"^\$?\s*(" + MONEY + r")$")
    qty_only = re.compile(r"^(?:qty|quantity)[:\s]*(\d{1,3})$|^x\s*(\d{1,3})$", re.I)
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        mq = qty_only.match(line)
        mp = price_only.match(line)
        if mq and pending:
            qty = int(mq.group(1) or mq.group(2) or 1)
        elif mp and pending:
            items.append(_item(pending, qty, money(mp.group(1))))
            pending, qty = None, 1
        elif _looks_like_product(line):
            pending, qty = line, 1
    return items


def _item(name, qty, unit_price):
    qty = max(1, qty)
    return dict(name=name[:200], qty=qty, unit_price=unit_price,
                line_total=round(unit_price * qty, 2))


def detect_kind(subject, body):
    blob = ("%s\n%s" % (subject or "", (body or "")[:2500])).lower()
    head = (subject or "").lower()
    for kind, words in KIND_KEYWORDS:
        if any(w in head for w in words):
            return kind
    for kind, words in KIND_KEYWORDS:
        if any(w in blob for w in words):
            return kind
    return ""


def parse(email, rule):
    """Turn one stored email plus its matching rule into order fields."""
    subject = email.get("subject") or ""
    body = email.get("body") or ""

    kind = rule["kind"] if rule["kind"] != "auto" else (detect_kind(subject, body) or "order")
    order_no = extract_order_no(subject, body, rule["order_no_regex"])
    total = extract_total(body, rule["total_regex"])
    items = extract_items(body, rule["item_regex"])
    tracking = extract_tracking(body) if kind in ("shipment", "delivery") else ""

    timing = rule["charge_timing"]
    if timing == "auto":
        timing = "at_ship" if kind == "preorder" else "at_order"

    problems = []
    if not order_no:
        problems.append("no order number found")
    if total <= 0 and kind not in ("shipment", "delivery", "cancellation"):
        problems.append("no order total found")
    items_sum = round(sum(i["line_total"] for i in items), 2)
    if items and total > 0 and items_sum > total + 0.5:
        problems.append("line items (%.2f) add up to more than the total (%.2f)"
                        % (items_sum, total))

    return dict(
        kind=kind,
        status=STATUS_BY_KIND.get(kind, "open"),
        order_no=order_no,
        retailer=rule["retailer"] or "",
        total=total,
        currency=rule["currency"] or "USD",
        charge_timing=timing,
        tracking=tracking,
        tag=rule["tag"] or "",
        items=items,
        problems=problems,
    )

"""User-defined rules that decide which emails matter and what they mean.

A rule is a set of conditions (sender / subject / body). Every condition you
fill in must pass; a condition left blank is ignored. Inside one condition the
comma-separated terms are OR'd -- "shipped, on its way" matches either.
Rules are checked in priority order (lowest number first) and the first one
that matches wins.
"""
import re

KINDS = ["auto", "order", "preorder", "shipment", "cancellation", "delivery"]
TIMINGS = ["auto", "at_order", "at_ship", "at_release"]

KIND_LABELS = {
    "auto": "Figure it out from the email",
    "order": "A regular order",
    "preorder": "A pre-order",
    "shipment": "A shipping notice",
    "cancellation": "A cancellation or refund",
    "delivery": "A delivery confirmation",
}

TIMING_LABELS = {
    "auto": "Figure it out",
    "at_order": "Charged immediately when ordered",
    "at_ship": "Charged when it ships",
    "at_release": "Charged on the release date",
}


def terms(value):
    """Split a comma-separated condition into individual search terms."""
    return [t.strip() for t in (value or "").split(",") if t.strip()]


def _hit(haystack, term, use_regex):
    if use_regex:
        try:
            return re.search(term, haystack, re.I | re.S) is not None
        except re.error:
            return False
    return term.lower() in haystack.lower()


def _any_hit(haystack, value, use_regex):
    return any(_hit(haystack, t, use_regex) for t in terms(value))


def check(rule, email):
    """Return a list of (condition_name, required, passed) for one rule."""
    sender = "%s %s" % (email.get("from_name", ""), email.get("from_addr", ""))
    subject = email.get("subject", "") or ""
    body = email.get("body", "") or ""
    rx = bool(rule["use_regex"])
    out = []

    if terms(rule["from_contains"]):
        out.append(("Sender contains", rule["from_contains"],
                    _any_hit(sender, rule["from_contains"], rx)))
    if terms(rule["subject_contains"]):
        out.append(("Subject contains", rule["subject_contains"],
                    _any_hit(subject, rule["subject_contains"], rx)))
    if terms(rule["subject_excludes"]):
        out.append(("Subject must NOT contain", rule["subject_excludes"],
                    not _any_hit(subject, rule["subject_excludes"], rx)))
    if terms(rule["body_contains"]):
        out.append(("Body contains", rule["body_contains"],
                    _any_hit(body, rule["body_contains"], rx)))
    return out


def matches(rule, email):
    if not rule["enabled"]:
        return False
    results = check(rule, email)
    if not results:
        return False  # a rule with no conditions would match everything
    return all(passed for _, _, passed in results)


def pick(rules, email):
    """First matching rule, by priority then id."""
    ordered = sorted(rules, key=lambda r: (r["priority"], r["id"]))
    for rule in ordered:
        if matches(rule, email):
            return rule
    return None


def imap_senders(rules):
    """Sender fragments worth asking the mail server about, across all rules."""
    found = []
    for rule in rules:
        if not rule["enabled"] or rule["use_regex"]:
            continue
        for t in terms(rule["from_contains"]):
            if t.lower() not in [f.lower() for f in found]:
                found.append(t)
    return found

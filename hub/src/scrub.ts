/**
 * Taking the secrets out of a log line.
 *
 * This runs on *this machine*, before a line is written to disk or posted to
 * the Hub. That ordering is the whole design. The alternative — ship the raw
 * line and clean it up on the server — means the raw line has already left the
 * building, and "we scrub it on arrival" is a promise about somebody else's
 * computer.
 *
 * ── What is actually at risk here ────────────────────────────────────────────
 *
 * Not payment details: nothing in the Watcher has ever seen one, and the buy
 * profile is a separate Chrome that this code does not drive. The real leaks
 * are duller and likelier:
 *
 *   · Target embeds a visitor id, a home store id and a postcode in every API
 *     URL it calls. Those URLs end up in error messages verbatim.
 *   · Windows puts the account name in every filesystem path, so one ENOENT
 *     spells out who you are.
 *   · The ingest token is a bearer token, and a 401 body is happy to quote it
 *     back at you.
 *
 * ── Two kinds of rule ────────────────────────────────────────────────────────
 *
 * Patterns catch the shapes above. But a pattern list only catches what
 * somebody thought of, so `scrub` also takes the literal secrets this process
 * knows about — its own token, its own Hub URL — and removes them by value.
 * That is the rule that still works on the leak nobody anticipated.
 *
 * Everything here is deliberately pure and deliberately over-eager. A log line
 * that lost a version number is a nuisance; one that kept a session cookie is
 * a different category of thing.
 */

/** What every removal leaves behind, so a reader can see something went. */
const MARK = '[redacted]';

/**
 * Key names whose value is never worth keeping.
 *
 * Matched on a word boundary, which is what keeps `productKey` and
 * `product_key` out of it — both are useful in a log and neither is a secret.
 */
const SENSITIVE_KEY =
  '(?:token|secret|password|passwd|pwd|auth|authorization|session|sid|cookie|' +
  'api_?key|key|card|cvv|cvc|account|visitor|visitor_?id|guest|guest_?id|' +
  'zip|zip_?code|postal|postcode|address|addr|phone|tel|ssn|latitude|longitude|lat|lon|lng)';

/**
 * A dotted quad with every octet in range.
 *
 * The range check is not pedantry — it is what stops this eating
 * `140.0.7339.207`, which is the Chrome version we log on purpose.
 */
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`\\b${OCTET}(?:\\.${OCTET}){3}\\b`, 'g');

/**
 * A long unbroken alphanumeric run with plenty of both digits and letters.
 *
 * The catch-all for identifiers nothing above named. Slugs survive it because
 * they contain hyphens; product names survive because they contain spaces.
 */
const OPAQUE_ID = /\b(?=[A-Za-z0-9]{24,}\b)(?=(?:[^0-9]*[0-9]){4})(?=(?:[^A-Za-z]*[A-Za-z]){4})[A-Za-z0-9]{24,}\b/g;

/** Escape a literal so it can go into a RegExp. */
function literal(s: string): RegExp {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
}

/**
 * Remove everything that should not travel.
 *
 * @param secrets literal values this process knows are secret — its own token,
 *   anything else it would not want quoted back. Short ones are ignored: a
 *   two-character "secret" would redact half the alphabet.
 */
export function scrub(input: string, secrets: readonly string[] = []): string {
  if (!input) return '';
  let s = String(input);

  // Known secrets first, by value, before any pattern can chop one in half and
  // leave the tail behind.
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) s = s.replace(literal(secret), MARK);
  }

  // Whole cookie headers. Never a case where the value is worth reading.
  s = s.replace(/\b(set-cookie|cookie)\s*:\s*[^\n]*/gi, `$1: ${MARK}`);

  // Bearer/Basic credentials.
  s = s.replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${MARK}`);

  // A URL's path says which retailer and which product, and is worth keeping.
  // Its query string is where Target puts the visitor id, the home store and
  // the postcode, and is worth nothing.
  s = s.replace(/(https?:\/\/[^\s"'<>]*?)\?[^\s"'<>]*/gi, `$1?${MARK}`);

  // key=value, anywhere else it appears.
  s = s.replace(new RegExp(`\\b${SENSITIVE_KEY}\\s*=\\s*[^&\\s"'<>,;)]+`, 'gi'), (m) =>
    `${m.split('=')[0]}=${MARK}`,
  );

  // "key": "value" and "key": 123, in JSON that got stringified into a message.
  s = s.replace(
    new RegExp(`("${SENSITIVE_KEY}"\\s*:\\s*)(?:"[^"]*"|-?[\\d.]+|true|false|null)`, 'gi'),
    `$1"${MARK}"`,
  );

  // Windows account name, which is in every local path on that machine.
  s = s.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'<>]+/gi, `$1${MARK}`);
  // The same on the other two platforms.
  s = s.replace(/(\/(?:home|Users)\/)[^/\s"'<>]+/g, `$1${MARK}`);

  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, MARK);
  s = s.replace(/\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, MARK);
  s = s.replace(IPV4, MARK);
  s = s.replace(OPAQUE_ID, MARK);

  // A bare postcode is only recognisable next to a state, and guessing at
  // five-digit numbers on their own would eat SKUs and prices.
  s = s.replace(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/g, `$1 ${MARK}`);

  return s;
}

/**
 * Is there anything left that looks like it should not be here?
 *
 * Used by the tests, and by the Hub on the way out. Deliberately a different
 * question from "did scrub run" — a clean-room check that can fail loudly
 * rather than a claim that the previous step worked.
 */
export function looksSensitive(text: string): string[] {
  const found: string[] = [];
  const check = (label: string, re: RegExp): void => {
    if (re.test(text)) found.push(label);
  };
  check('email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  check('ip address', new RegExp(`\\b${OCTET}(?:\\.${OCTET}){3}\\b`));
  check('bearer token', /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/i);
  check('cookie header', /\b(set-)?cookie\s*:\s*(?!\[redacted\])\S/i);
  check('user path', /[A-Za-z]:[\\/]+Users[\\/]+(?!\[redacted\])[^\\/\s"'<>]+/i);
  check('opaque id', new RegExp(OPAQUE_ID.source));
  check('query string', /https?:\/\/[^\s"'<>]*\?(?!\[redacted\])\S/i);
  return found;
}

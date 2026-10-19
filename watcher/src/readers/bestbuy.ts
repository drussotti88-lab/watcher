/**
 * Reading a Best Buy product page: alerts only.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * Since late 2025 Best Buy has sold its scarcest Pokémon online by invitation:
 * the product page offers a button to ask for an invite, Best Buy picks who
 * gets one, and an invite is good for 24 hours. So the event worth waking
 * somebody for is not "in stock" but "the invite list just opened" - and the
 * act that follows, asking, is the account holder applying to buy. Phantom
 * reads Best Buy signed out and NEVER presses that button, or any other. This
 * reader only says which state the page is in.
 *
 * ── How sure it is, and why it says unknown so often ────────────────────────
 *
 * Written 19 Oct 2026 from Best Buy's button wording as shoppers describe it,
 * not from a captured invite window. The words differ from guide to guide
 * ("Ask for invite", "Request invite", plain "Invite"), and a product page is
 * full of OTHER buttons - every "customers also bought" tile has its own Add
 * to Cart. So this is narrow on purpose:
 *
 *   - only the buy button for THIS sku counts (Best Buy stamps data-sku-id on
 *     it), or failing that the one inside the fulfilment box;
 *   - a label it does not recognise is `unknown`, never a guess;
 *   - two buttons for the same sku that disagree are `unknown` too.
 *
 * "Invitation requested" can only appear in a signed-in browser, which the
 * watching profile never is (rule 6). It is recognised anyway, so the reader
 * is right the day somebody looks at a page some other way.
 */
import type { StockState, Confidence } from '../types.ts';
import type { ProductRead, SellerKind } from './types.ts';
import { unknownRead } from './types.ts';

/** One button-like element from the page, as scrape() in read.ts saw it. */
export interface PageButton {
  text: string;
  /** Best Buy's own data-button-state, e.g. ADD_TO_CART, SOLD_OUT. Blank if absent. */
  state: string;
  /** data-sku-id, the product the button acts on. Blank if absent. */
  sku: string;
  disabled: boolean;
  /** Inside the fulfilment / add-to-cart box rather than a carousel. */
  inBuyBox: boolean;
}

export type InviteState = 'open' | 'requested';

/** What one button says, in the reader's vocabulary. */
export type ButtonMeaning =
  | { kind: 'invite'; invite: InviteState }
  | { kind: 'in'; preOrder: boolean }
  | { kind: 'out' }
  | { kind: 'unknown' };

/**
 * One button's label (and Best Buy's state code) to a meaning.
 *
 * Requested is checked before open, because "Invitation requested" contains
 * the word that the open rule looks for. Disabled matters only for add to
 * cart: a greyed-out "Add to Cart" is a page that will not sell.
 */
export function meaningOf(b: Pick<PageButton, 'text' | 'state' | 'disabled'>): ButtonMeaning {
  const text = String(b.text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const code = String(b.state ?? '').trim().toUpperCase();

  if (
    /\binvit(e|ation)s? (has been |was )?(requested|sent|received)\b/.test(text) ||
    /\brequested\b.*\binvit/.test(text) ||
    /\byou('|’)?re on the (invite )?list\b/.test(text) ||
    (code.includes('INVITE') && code.includes('REQUESTED'))
  ) {
    return { kind: 'invite', invite: 'requested' };
  }
  if (
    /^(ask|request|apply)( for)?( an)? invit(e|ation)$/.test(text) ||
    /^(get|request)( an)? invite$/.test(text) ||
    /^invite$/.test(text) ||
    /^request (an )?invitation to (buy|purchase)$/.test(text) ||
    code === 'ASK_FOR_INVITE' || code === 'REQUEST_INVITE' || code === 'INVITE'
  ) {
    return { kind: 'invite', invite: 'open' };
  }
  if ((text === 'add to cart' || code === 'ADD_TO_CART') && !b.disabled) {
    return { kind: 'in', preOrder: false };
  }
  if ((text === 'pre-order' || text === 'preorder' || code === 'PRE_ORDER') && !b.disabled) {
    return { kind: 'in', preOrder: true };
  }
  if (
    text === 'sold out' || text === 'coming soon' || text === 'unavailable nearby' ||
    text === 'check stores' || text === 'unavailable' ||
    code === 'SOLD_OUT' || code === 'COMING_SOON' || code === 'CHECK_STORES' ||
    ((text === 'add to cart' || code === 'ADD_TO_CART') && b.disabled)
  ) {
    return { kind: 'out' };
  }
  return { kind: 'unknown' };
}

/** The buttons that speak for this sku, and nothing from a carousel. */
export function buttonsForSku(buttons: readonly PageButton[], sku: string): PageButton[] {
  const mine = buttons.filter((b) => b.sku && b.sku === sku);
  if (mine.length > 0) return mine;
  // No button carries a sku at all: the buy box is the only safe source.
  // A button carrying a DIFFERENT sku is somebody else's product.
  return buttons.filter((b) => !b.sku && b.inBuyBox);
}

interface LdLite {
  name: string;
  price: number | null;
  seller: string;
}

/** Name, price and seller from schema.org Product markup, when present. */
export function bestBuyLd(blocks: readonly unknown[], sku: string): LdLite | null {
  const found: (LdLite & { sku: string })[] = [];
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj['@graph'])) obj['@graph'].forEach(visit);
    if (String(obj['@type'] ?? '').toLowerCase() === 'product') {
      const offers = Array.isArray(obj.offers) ? obj.offers : obj.offers ? [obj.offers] : [];
      const o = (offers[0] ?? {}) as Record<string, unknown>;
      const seller = (o.seller ?? {}) as Record<string, unknown>;
      found.push({
        name: String(obj.name ?? ''),
        sku: String(obj.sku ?? ''),
        price: num(o.price ?? o.lowPrice),
        seller: String(seller.name ?? ''),
      });
    }
  };
  blocks.forEach(visit);
  return found.find((f) => f.sku === sku) ?? (found.length === 1 ? found[0]! : null);
}

/**
 * The reading. State and invite come from the button; price, name and seller
 * from the markup.
 *
 * An open invite list reads `out` with `invite: 'open'`: the page will not put
 * the thing in a cart, and calling it "in stock" would fire the in-stock card
 * at a page with no Add to Cart on it. The invite has its own card.
 */
export function readBestBuy(
  scraped: { ld: readonly unknown[]; buttons: readonly PageButton[] },
  sku: string,
): ProductRead {
  const ld = bestBuyLd(scraped.ld, sku);
  const buttons = buttonsForSku(scraped.buttons, sku);
  if (buttons.length === 0) {
    return unknownRead(`no buy button for sku ${sku} on the page`, ld?.name ?? '');
  }

  const meanings = buttons.map(meaningOf);
  const invite: InviteState | null =
    meanings.some((m) => m.kind === 'invite' && m.invite === 'requested') ? 'requested'
    : meanings.some((m) => m.kind === 'invite' && m.invite === 'open') ? 'open'
    : null;

  let state: StockState = 'unknown';
  let preOrder = false;
  if (invite) {
    state = 'out';
  } else {
    const kinds = new Set(meanings.map((m) => m.kind));
    // Every button for this sku agrees, or it is not an answer.
    if (kinds.size === 1 && !kinds.has('unknown')) {
      const only = meanings[0]!;
      state = only.kind === 'in' ? 'in' : 'out';
      preOrder = only.kind === 'in' && only.preOrder;
    }
  }

  const label = buttons.map((b) => b.text || b.state).filter(Boolean).join(' / ').slice(0, 80);
  if (state === 'unknown') {
    return {
      ...unknownRead(`button said "${label}" - not a state this reader knows`, ld?.name ?? ''),
      price: ld?.price ?? null,
      invite: null,
    };
  }

  // Best Buy has run a marketplace since 2025. Only a seller the markup NAMES
  // as Best Buy is the shop; another name is a reseller; no name is unknown,
  // which the alerts treat as never-news, the same as everywhere else.
  const sellerKind: SellerKind = !ld?.seller ? 'unknown'
    : /best\s*buy/i.test(ld.seller) ? 'retailer' : 'marketplace';
  const confidence: Confidence = ld?.price !== null && ld?.price !== undefined ? 'exact' : 'inferred';

  return {
    name: ld?.name ?? '',
    price: ld?.price ?? null,
    state,
    confidence,
    availableQuantity: null,
    orderLimit: null,
    pickupAvailable: false,
    seller: { kind: sellerKind, name: ld?.seller ?? '' },
    // True only when the button for this sku is a live Add to Cart. Anything
    // else is "did not say", which judge() never reads as no.
    addToCart: state === 'in' ? true : null,
    preOrder: { isPreOrder: preOrder, releaseDate: null },
    invite,
    note: invite ? `invite ${invite}: "${label}"` : `button "${label}"`,
  };
}

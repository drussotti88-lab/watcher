'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { featureOn } from '@/lib/features';
import { useFeatures } from '@/components/layout/FeatureContext';

// ── THE THREE PLANS, PRICED ────────────────────────────────────────────────────
//
// Free, Pro and Vendor as three cards, in the shape people expect a pricing table to take —
// owner's request, 2026-08-21, working from a reference layout.
//
// EACH CARD HAS ITS OWN CHECKOUT. Previously the vendor tier was described in one place and
// bought in another, and Pro's button lived above a comparison table that mentioned a tier it
// couldn't sell you. One card, one price, one button that starts exactly that purchase.
//
// THE ONE-LINERS SAY WHO IT'S FOR, not what it contains. The full list lives in the table below
// and repeating it here would make three columns of the same twenty rows — which is the version
// nobody reads. "For working a table" tells a dealer more than four ticks do.

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: 'Free',
    per: 'forever',
    note: 'No card, no trial clock.',
    tone: 'var(--t2)',
    head: 'linear-gradient(135deg, #3a3752, #2b2940)',
    points: [
      'Your whole collection, tracked',
      'Prices from real completed sales',
      'Unlimited CSV import',
      'Card scanner & watchlist',
      'Trade Analyzer',
    ],
  },
  {
    id: 'pro',
    name: 'Vault Pro',
    price: '$4',
    per: '/ month',
    alt: { price: '$40', per: '/ year', note: 'Two months free · 7 days free' },
    note: '7 days free, then $4. Cancel any time.',
    tone: 'var(--gold)',
    head: 'linear-gradient(135deg, #b08718, #8a6a12)',
    featured: true,
    points: [
      'Everything in Free',
      'Execute trades with cost basis carried',
      'Grading Lab & DNA Score Engine™',
      'Market Intelligence & Vault Picks',
      'Price alerts on your watchlist',
      'Monthly Vault Rip pack & giveaways',
    ],
  },
  {
    id: 'phantom',
    name: 'Phantom by DNA',
    price: '$10',
    per: '/ month',
    alt: { price: '$100', per: '/ year', note: 'Two months free' },
    note: 'The retail watcher, and its own app.',
    tone: '#5fd7ff',
    head: 'linear-gradient(135deg, #1b67b7, #12294e)',
    // NOT A RUNG ON THE LADDER. Phantom is its own product on its own terms, and it does NOT
    // include Vault Pro (owner call 2026-09-03) - so the card makes no Pro claim at all. What
    // sets it apart is its own mark and its own border, sitting forward of the tier ladder
    // rather than in it.
    standalone: true,
    mark: 'ti-ghost',
    points: [
      'Release radar & drop alerts at Target, Walmart and Pokémon Center',
      'Queue alarms the moment a waiting room goes up',
      'New-product discovery before street date',
      'Confirmed pickups flow straight into your vault',
    ],
  },
  {
    id: 'vendor',
    name: 'Vendor',
    price: '$12.99',
    per: '/ month',
    alt: { price: '$129.90', per: '/ year', note: 'Two months free' },
    note: 'For working tables at shows.',
    tone: 'var(--br)',
    head: 'linear-gradient(135deg, #5f56c4, #453d9e)',
    points: [
      'Everything in Pro',
      'Vendor HQ — run your table like a register',
      'One lot shared live across two tables',
      'Name your shows, see what each one made',
      'Bulk-scanner files into your collection',
    ],
  },
];

export default function PlanCards({ onCheckout, starting, currentPlan }) {
  const router = useRouter();
  const { isPro, isVendor, isPhantom, states, isAdmin } = useFeatures();
  // Is the Phantom tier open for sale yet? Admins always see it so the owner can check the card
  // before flipping it live — the same rule every other switch follows.
  const phantomSellable = featureOn('tier.phantom', states, { isPro, isVendor, isAdmin });
  const [cycle, setCycle] = useState('monthly');
  const [paypalOn, setPaypalOn] = useState(false);
  const [paused, setPaused] = useState(false);   // owner kill switch — buttons say so, not vanish

  useEffect(() => {
    fetch('/api/paypal/checkout')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setPaypalOn(!!d?.configured); setPaused(!!d?.paused); })
      .catch(() => {});
  }, []);

  // What the reader already has, so a card never sells something they're paying for.
  const held = (id) => (id === 'free') || (id === 'pro' && isPro) || (id === 'vendor' && isVendor) || (id === 'phantom' && isPhantom);

  // Phantom renders as its own band BELOW the tier grid (see the end of the return), because it
  // is a separate service bridged into the vault rather than a rung on this ladder. Sitting it
  // in the tier row invited the one comparison it should never have invited.
  //
  // The banner is optional: if /phantom-banner.png is not there yet, onError flips bannerOk and
  // the band falls back to its gradient. Correct today, better the moment the art lands, and no
  // broken image in between.
  const [bannerOk, setBannerOk] = useState(true);
  const bannerRef = useRef(null);
  // onError ALONE IS NOT ENOUGH. When the file is missing the request fails before hydration
  // attaches the handler, so the event is gone by the time React is listening and the band
  // keeps a broken image forever. A mounted img reporting complete with naturalWidth 0 has
  // already failed - that is exactly the case onError cannot see.
  useEffect(() => {
    const el = bannerRef.current;
    if (el && el.complete && el.naturalWidth === 0) setBannerOk(false);
  }, []);
  const phantom = PLANS.find((p) => p.id === 'phantom');
  const phantomOn = phantomSellable || isPhantom;
  const phantomMine = !!isPhantom;
  const phantomAnnual = cycle === 'annual' && phantom?.alt;
  const phantomPrice = phantomAnnual ? phantom.alt.price : phantom?.price;
  const phantomPer = phantomAnnual ? phantom.alt.per : phantom?.per;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', color: 'var(--t3)' }}>BILLING</span>
        {[['monthly', 'Monthly'], ['annual', 'Annual · 2 months free']].map(([k, lbl]) => (
          <button key={k} onClick={() => setCycle(k)}
            style={{
              height: 28, padding: '0 12px', borderRadius: 8, fontSize: 11.5, fontWeight: 800, cursor: 'pointer',
              border: '1px solid ' + (cycle === k ? 'var(--br)' : 'var(--bo)'),
              background: cycle === k ? 'rgba(127,119,221,.14)' : 'transparent',
              color: cycle === k ? 'var(--br)' : 'var(--t2)',
            }}>{lbl}</button>
        ))}
        {/* Both paid tiers price the year at ten months — one rule, said once. */}
        <span style={{ fontSize: 10.5, color: 'var(--t3)' }}>Pay for 10 months, get 12 — on either plan.</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(228px, 1fr))', gap: 11, marginBottom: 11, alignItems: 'start' }}>
        {/* PHANTOM SHIPS DARK. The tier is code-complete, but Phantom is not selling yet and a
            purchasable subscription to an unlaunched app takes real money for nothing. Gated on
            tier.phantom (default OFF) so the owner turns it on the day Phantom opens — the whole
            reason the feature board exists. Anyone who already HOLDS it still sees their door, so
            flipping the switch off can never strand a paying member. */}
        {PLANS.filter((p) => p.id !== 'phantom').map((p) => {
          const annual = cycle === 'annual' && p.alt;
          const price = annual ? p.alt.price : p.price;
          const per = annual ? p.alt.per : p.per;
          const note = annual ? p.alt.note : p.note;
          const mine = held(p.id);
          return (
            <div key={p.id} className="card"
              style={{
                marginBottom: 0, padding: 0, overflow: 'hidden',
                border: p.featured ? '1px solid var(--gold)' : p.standalone ? `1px solid ${p.tone}` : undefined,
                boxShadow: p.standalone ? '0 14px 34px rgba(27,103,183,.30)' : undefined,
                display: 'flex', flexDirection: 'column',
              }}>
              <div style={{ background: p.head, padding: '16px 14px', textAlign: 'center', color: '#fff' }}>
                {p.mark && (
                  <div style={{ width: 34, height: 34, borderRadius: '50%', margin: '0 auto 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,.15)', border: '1px solid rgba(255,255,255,.32)' }}>
                    <i className={`ti ${p.mark}`} style={{ fontSize: 19 }} />
                  </div>
                )}
                <div style={{ fontFamily: 'Syne, sans-serif', fontWeight: 800, fontSize: 17 }}>{p.name}</div>
                <div style={{ fontSize: 10, opacity: 0.85, marginTop: 3, textTransform: 'uppercase', letterSpacing: '.06em' }}>{note}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 5, marginTop: 9 }}>
                  <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em' }}>{price}</span>
                  <span style={{ fontSize: 12, opacity: 0.9 }}>{per}</span>
                </div>

              </div>

              <div style={{ padding: '14px 14px 16px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                {p.points.map((pt) => (
                  <div key={pt} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.45 }}>
                    <i className="ti ti-check" style={{ fontSize: 14, color: p.tone, flexShrink: 0, marginTop: 1 }} />
                    <span>{pt}</span>
                  </div>
                ))}

                <div style={{ marginTop: 'auto', paddingTop: 12 }}>
                  {mine ? (
                    p.id === 'phantom' ? (
                      // Held Phantom is a DOOR, not a badge: the tier's whole point is the app
                      // behind it, and this is the signed-in way through (api/phantom/launch).
                      <a className="btn" href="/api/phantom/launch"
                        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}>
                        <i className="ti ti-eye" style={{ marginRight: 6 }} /> Open Phantom
                      </a>
                    ) : (
                      <div style={{ textAlign: 'center', fontSize: 11.5, fontWeight: 800, color: p.tone, border: '1px solid var(--bo)', borderRadius: 10, padding: '9px 0' }}>
                        <i className="ti ti-circle-check" style={{ marginRight: 5 }} />
                        {p.id === 'free' ? 'Always yours' : 'Your plan'}
                      </div>
                    )
                  ) : paused ? (
                    // The owner's pause. Honest and temporary-sounding, because it is both.
                    <div style={{ textAlign: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--t2)', border: '1px solid var(--bo)', borderRadius: 10, padding: '9px 0' }}>
                      <i className="ti ti-clock-pause" style={{ marginRight: 5 }} />
                      Temporarily unavailable
                    </div>
                  ) : !paypalOn ? (
                    // Honest rather than a button that 503s. Someone reading this should be told
                    // how to get it, not left tapping a dead control.
                    <div style={{ fontSize: 11, color: 'var(--t2)', lineHeight: 1.5, textAlign: 'center' }}>
                      Checkout isn&rsquo;t switched on yet — message us and we&rsquo;ll set you up.
                    </div>
                  ) : (
                    <button className="btn" disabled={starting}
                      onClick={() => onCheckout?.({ tier: p.id === 'vendor' || p.id === 'phantom' ? p.id : 'pro', cycle: annual ? 'annual' : 'monthly' })}
                      style={{ width: '100%', opacity: starting ? 0.6 : 1 }}>
                      {starting
                        ? <><i className="ti ti-loader spinning" /> Opening PayPal…</>
                        : <><i className="ti ti-brand-paypal" /> {p.id === 'pro' ? 'Start free trial' : p.id === 'phantom' ? 'Get Phantom' : 'Get Vendor'}</>}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── PHANTOM: BELOW THE LADDER, NOT ON IT ──────────────────────────────────────────────
          Phantom is a separate service that happens to be bridged into the vault and billed
          through it. Sitting it in the tier row invited exactly the comparison it should not
          invite - "Phantom plus Pro costs more than Vendor" - which is arithmetic on a premise
          that was never true. So it gets its own full-width band under the tiers, where nothing
          about the layout suggests it is a rung.

          THE BANNER IS OPTIONAL BY DESIGN. /phantom-banner.png does not have to exist: onError
          falls back to the gradient with a watermark, so this ships correct today and lights up
          the moment the art lands, with no second deploy and no broken image in between. */}
      {phantomOn && phantom && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 11, border: `1px solid ${phantom.tone}`, boxShadow: '0 14px 34px rgba(27,103,183,.30)' }}>
          {/* The art is 1200x630. Forcing it into a letterbox strip cropped the status chips off
              the bottom of the eye banner, so the band takes the ARTWORK'S aspect and centres it
              on a ground that matches its near-black edges - rather than bending the art to a
              shape it was not drawn for. */}
          <div style={{ width: '100%', overflow: 'hidden', background: bannerOk ? '#0A0912' : phantom.head, ...(bannerOk ? {} : { height: 84, position: 'relative' }) }}>
            {bannerOk ? (
              <div style={{ maxWidth: 700, margin: '0 auto', aspectRatio: '1200 / 630' }}>
                <img ref={bannerRef} src="/phantom-banner.webp"
                  alt="Phantom by DNA - it watches the drop, you get the box"
                  onError={() => setBannerOk(false)}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              </div>
            ) : (
              <i className="ti ti-ghost" aria-hidden="true"
                style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 64, color: 'rgba(255,255,255,.16)' }} />
            )}
          </div>

          <div style={{ padding: '15px 16px 17px', display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                <i className="ti ti-ghost" style={{ fontSize: 20, color: phantom.tone }} />
                <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 800, fontSize: 19 }}>{phantom.name}</span>
                <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: phantom.tone, border: `1px solid ${phantom.tone}`, borderRadius: 20, padding: '3px 9px' }}>
                  A separate service
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 6, lineHeight: 1.5 }}>
                Its own app, opened signed in from here. Sold through the vault, but not part of the
                membership tiers above.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '7px 18px', marginTop: 12 }}>
                {phantom.points.map((pt) => (
                  <div key={pt} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.45 }}>
                    <i className="ti ti-check" style={{ fontSize: 14, color: phantom.tone, flexShrink: 0, marginTop: 1 }} />
                    <span>{pt}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ flex: '0 0 auto', minWidth: 208, marginLeft: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, justifyContent: 'flex-end' }}>
                <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em' }}>{phantomPrice}</span>
                <span style={{ fontSize: 12, color: 'var(--t2)' }}>{phantomPer}</span>
              </div>
              <div style={{ marginTop: 11 }}>
                {phantomMine ? (
                  <a className="btn" href="/api/phantom/launch"
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}>
                    <i className="ti ti-eye" style={{ marginRight: 6 }} /> Open Phantom
                  </a>
                ) : paused ? (
                  <div style={{ textAlign: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--t2)', border: '1px solid var(--bo)', borderRadius: 10, padding: '9px 0' }}>
                    <i className="ti ti-clock-pause" style={{ marginRight: 5 }} /> Temporarily unavailable
                  </div>
                ) : !paypalOn ? (
                  <div style={{ fontSize: 11, color: 'var(--t2)', lineHeight: 1.5, textAlign: 'center' }}>
                    Checkout isn&rsquo;t switched on yet - message us and we&rsquo;ll set you up.
                  </div>
                ) : (
                  <button className="btn" disabled={starting}
                    onClick={() => onCheckout?.({ tier: 'phantom', cycle: cycle === 'annual' ? 'annual' : 'monthly' })}
                    style={{ width: '100%', opacity: starting ? 0.6 : 1 }}>
                    {starting
                      ? <><i className="ti ti-loader spinning" /> Opening PayPal.</>
                      : <><i className="ti ti-brand-paypal" /> Get Phantom</>}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

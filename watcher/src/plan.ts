/**
 * What a sweep is going to do, before it does any of it.
 *
 * Pulled out of index.ts because index.ts is a command-line entry point: it
 * calls main() on import, so anything that lives there cannot be imported by a
 * test without running the program. These two functions decide the order two
 * retailers get read in, which is worth testing on its own.
 */

/** One unit of sweeping: a Target query page, or a Pokémon Center category page. */
export type SweepStep =
  | { retailer: string; kind: 'target'; query: string; offset: number }
  | { retailer: string; kind: 'pc'; category: string; page: number };

/**
 * Alternate two lists, longest tail last.
 *
 * The property that matters is not "perfectly alternating" — it is that
 * neither retailer's steps all sit behind the other's. Pacing is held per
 * retailer, so a plan with every Target step first makes Target's cooldown
 * into Pokémon Center's cooldown as well, and the second shop is read at the
 * speed of the first.
 */
export function interleave<T>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (i < a.length) out.push(a[i]!);
    if (i < b.length) out.push(b[i]!);
  }
  return out;
}

/**
 * Today, as a plain date in this machine's own zone.
 *
 * Local rather than UTC on purpose: "released 41 days ago" is a judgement made
 * on the calendar the person reading it lives on, and at 7pm Central the UTC
 * date is already tomorrow.
 */
export function todayLocal(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

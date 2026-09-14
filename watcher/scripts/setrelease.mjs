// Put the two 30th Celebration Battle Decks on the same street date as the
// other seven Target items, so release-week cadence covers them on the 16th.
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('../watcher.config.json', import.meta.url), 'utf8'));
const base = (cfg.hub?.url || cfg.hubUrl || '').replace(/\/$/, '');
const token = cfg.hub?.token || cfg.hubToken || '';
const res = await fetch(base + '/api/products/bulk', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify({
    action: 'release-date',
    releaseDate: '2026-09-16',
    keys: [
      'prd_pok_233_mon_trading_card_game_30th_celebration_battle_deck_8',
      'prd_p',
    ],
  }),
});
console.log(res.status, await res.text());

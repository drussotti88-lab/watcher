// Render the "PHANTOM by DNA" brand block as a transparent PNG.
// PHANTOM is set in Poppins Bold (the closest installed face to the logo's
// rounded geometry); DNA is the path traced from the logo's own letterforms,
// so the maker's mark stays literally the maker's lettering.
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const path = readFileSync('/home/claude/scratch/dna-path.txt', 'utf8').trim();

// The traced path lives at x 122..395, y 387.9..456.8 in old-icon space.
// Re-anchor to its own origin so it can be placed freely.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="150" viewBox="0 0 512 150">
  <defs>
    <linearGradient id="dna" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#34bbe2"/>
      <stop offset="50%" stop-color="#238ccc"/>
      <stop offset="100%" stop-color="#1b67b7"/>
    </linearGradient>
  </defs>
  <g font-family="Poppins" font-weight="700" text-anchor="middle">
    <text x="256" y="62" font-size="72" letter-spacing="3"
          stroke="#0a1435" stroke-width="12" stroke-linejoin="round">PHANTOM</text>
    <text x="256" y="62" font-size="72" letter-spacing="3"
          fill="url(#dna)" stroke="#7cc9f5" stroke-width="2">PHANTOM</text>
  </g>
  <!-- line 2: "by" + the traced DNA, sized to read as the maker's byline -->
  <g transform="translate(160 86)">
    <text x="0" y="42" font-family="Poppins" font-weight="700" font-size="30"
          stroke="#0a1435" stroke-width="8" stroke-linejoin="round">by</text>
    <text x="0" y="42" font-family="Poppins" font-weight="700" font-size="30"
          fill="url(#dna)" stroke="#7cc9f5" stroke-width="1">by</text>
    <g transform="translate(48 0) scale(0.78) translate(-122 -387.9)">
      <path d="${path}" fill="none" stroke="#0a1435" stroke-width="14" stroke-linejoin="round" opacity=".9"/>
      <path d="${path}" fill="url(#dna)" fill-rule="evenodd" stroke="#7cc9f5" stroke-width="2.5"/>
    </g>
  </g>
</svg>`;

const html = `<!doctype html><body style="margin:0;background:transparent">${svg}</body>`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 512, height: 150 } });
await page.setContent(html);
await page.waitForTimeout(400);
await page.screenshot({ path: '/home/claude/scratch/phantom-text.png', omitBackground: true });
await browser.close();
console.log('brand block rendered');

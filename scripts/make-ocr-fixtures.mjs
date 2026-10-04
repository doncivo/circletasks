// Jeu d'images de test de l'OCR (Q-04, décision D7) : `node scripts/make-ocr-fixtures.mjs`.
// Rend des listes françaises dans Chromium (Playwright) et écrit tests/fixtures/ocr/*.png|jpg + expected.json.
// Les images sont versionnées (déterministes à la police près) : ce script ne sert qu'à les régénérer.
// Imprimé = lisible par les deux moteurs ; manuscrit (police script) = exactitude non exigée, seule la chaîne lignes -> tâches l'est.
/* global document, console */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('tests/fixtures/ocr');
mkdirSync(OUT, { recursive: true });

const PRINTED = ['Appeler le plombier', 'Acheter des ampoules', 'Réserver le restaurant samedi', 'Payer la cantine', 'Rendez-vous au garage'];
const BULLETS = ['- Appeler le notaire demain 10h', '• Acheter du pain', '1. Envoyer la facture', '2. Réserver le dentiste', '[ ] Payer le loyer'];
const HANDWRITTEN = ['plombier', 'ampoules', 'resto samedi', 'cantine', 'garage ?'];
const SHEET = HANDWRITTEN.map((line) => `– ${line}`);

function page({ lines, font, size = 44, rotate = 0, background = '#ffffff', color = '#111111', width = 900, extra = '' }) {
  const rows = lines.map((line) => `<div class="l">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:${background}}
    body{width:${width}px;padding:48px 56px;box-sizing:border-box;font:${size}px/1.6 ${font};color:${color}}
    .w{transform:rotate(${rotate}deg);transform-origin:left top}
    ${extra}
  </style><div class="w">${rows}</div>`;
}

const FILES = [
  { name: 'liste-imprimee.png', html: page({ lines: PRINTED, font: "'Segoe UI', Arial, sans-serif" }), lines: PRINTED, readable: true },
  { name: 'liste-puces.png', html: page({ lines: BULLETS, font: "'Segoe UI', Arial, sans-serif" }), lines: BULLETS, readable: true },
  {
    name: 'liste-manuscrite.png',
    html: page({ lines: HANDWRITTEN, font: "'Ink Free', 'Segoe Script', cursive", size: 54, rotate: -2, background: '#fbf7ec', color: '#33406b' }),
    lines: HANDWRITTEN,
    readable: false,
  },
  {
    // Feuille portrait de Scan.html (vignette de la relecture) : 300 x 380, tirets et écriture script.
    name: 'feuille-manuscrite.png',
    viewport: { width: 300, height: 380 },
    html: page({ lines: SHEET, font: "'Ink Free', 'Segoe Script', cursive", size: 30, background: '#fbf7ec', color: '#33406b', width: 300, extra: 'body{padding:28px 24px;line-height:1.75}' }),
    lines: SHEET,
    readable: false,
  },
  {
    name: 'photo-liste.jpg',
    type: 'jpeg',
    html: page({
      lines: PRINTED,
      font: "'Segoe UI', Arial, sans-serif",
      size: 40,
      rotate: 1.5,
      background: 'linear-gradient(100deg,#e9e4d8 0%,#f7f3e8 55%,#d8d2c2 100%)',
      color: '#2a2a2a',
    }),
    lines: PRINTED,
    readable: true,
  },
  { name: 'page-vide.png', html: page({ lines: [], font: 'Arial' }), lines: [], readable: true },
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1, locale: 'fr-FR' });
const expected = {};
for (const file of FILES) {
  const tab = await context.newPage();
  await tab.setViewportSize(file.viewport ?? { width: 900, height: 520 });
  await tab.setContent(file.html);
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: resolve(OUT, file.name), type: file.type ?? 'png', ...(file.type === 'jpeg' ? { quality: 82 } : {}) });
  await tab.close();
  expected[file.name] = { lines: file.lines, readable: file.readable };
}
await browser.close();
writeFileSync(resolve(OUT, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
console.log(`Images écrites dans ${OUT}`);

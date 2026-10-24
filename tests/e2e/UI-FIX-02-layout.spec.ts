import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Géométrie réelle des conteneurs communs, avec une encoche de 59 px et une barre basse de 34 px.
// Les styles sont ceux livrés par l'app ; aucune valeur CSS de correctif n'est dupliquée ici.
const styles = ['src/ui/theme/tokens.css', 'src/ui/AppShell.css', 'src/ui/Sheet.css', 'src/features/sync/IosPairingScreen.css', 'src/features/capture/scan/ScanDialog.css', 'src/features/security/security.css', 'src/ui/ConfirmDialog.css', 'src/ui/ChoiceDialog.css', 'src/ui/DatePrompt.css', 'src/features/settings/BackupSheet.css', 'src/features/stats/ExportDialog.css', 'src/features/settings/OnboardingHost.css'].map((file) => readFileSync(file, 'utf8')).join('\n');
const items = Array.from({ length: 60 }, (_, i) => `<p>Ligne ${i}</p>`).join('');
const viewport = '<meta name="viewport" content="width=device-width,initial-scale=1">';

test('UI-FIX-02 : couleurs calculées, attente et dossier choisi distincts du succès', async ({ page }) => {
  const syncStyles = ['src/features/sync/SyncDetailsScreen.css', 'src/features/sync/SyncSettingsSection.css'].map((file) => readFileSync(file, 'utf8')).join('\n');
  await page.setContent(`${viewport}<style>${styles}${syncStyles}</style><span id="success" class="ct-sync__sub" data-tone="success">À jour</span><span id="waiting" class="ct-sync__sub" data-tone="neutral">En attente</span><span id="chosen" class="ct-sync__ok">Dossier choisi</span>`);
  const color = (id: string) => page.locator(id).evaluate((el) => getComputedStyle(el).color);
  expect(await color('#waiting')).not.toBe(await color('#success'));
  expect(await color('#chosen')).not.toBe(await color('#success'));
});

test('UI-FIX-02 : les statuts restent dans la même colonne malgré les noms et la dernière lecture', async ({ page }) => {
  // Charger Réglages après Synchro reproduit aussi l'ordre défavorable des styles à la demande.
  const rowStyles = ['src/features/sync/SyncDetailsScreen.css', 'src/features/settings/SettingsScreen.css'].map((file) => readFileSync(file, 'utf8')).join('\n');
  const rows = ['Cet iPhone', 'Mon ordinateur du bureau avec un nom long', 'Ancien PC'].map((name, i) => `<li class="ct-settings__row ct-sync__device"><div class="ct-sync__deviceIdentity"><span>${name}</span><span class="ct-sync__deviceRead">Dernière modification lue : hier à 10:00</span></div><span class="ct-settings__value ct-sync__deviceState">${i === 2 ? 'Oublié' : 'Actif'}</span></li>`).join('');
  await page.setContent(`${viewport}<style>${styles}${rowStyles}</style><div class="ct-sync"><ul class="ct-sync__devices">${rows}</ul></div>`);
  const positions = await page.locator('.ct-sync__deviceState').evaluateAll((nodes) => nodes.map((el) => ({ x: el.getBoundingClientRect().x, right: el.getBoundingClientRect().right })));
  expect(new Set(positions.map((p) => Math.round(p.x))).size).toBe(1);
  expect(new Set(positions.map((p) => Math.round(p.right))).size).toBe(1);
});

test('UI-FIX-02 : le défilement de chaque écran reste sous la barre d’état', async ({ page }) => {
  await page.setContent(`${viewport}<style>${styles}\nhtml,body{margin:0;height:100%}:root{--ct-safe-area-top:59px;--ct-safe-area-bottom:34px}</style><div class="app-shell"><div class="ct-app-shell" data-layout="mobile"><main class="ct-app-shell__main"><h1>Réglages</h1>${items}</main></div></div>`);
  const main = page.locator('main');
  await main.evaluate((el) => { el.scrollTop = 300; });
  const geometry = await main.evaluate((el) => ({ top: el.getBoundingClientRect().top, scroll: el.scrollTop }));
  expect(geometry.scroll).toBeGreaterThan(0);
  expect(geometry.top).toBeGreaterThanOrEqual(59);
});

for (const [name, content, selector] of [
  ['association', `<div class="ct-ios-pair">${items}</div>`, '.ct-ios-pair'],
  ['scan', `<div class="ct-scan__backdrop" data-layout="mobile"><div class="ct-scan" data-layout="mobile">${items}</div></div>`, '.ct-scan'],
  ['verrouillage', `<div class="ct-lock">${items}</div>`, '.ct-lock'],
  ['confirmation', `<div class="ct-confirm__backdrop"><div class="ct-confirm">${items}</div></div>`, '.ct-confirm'],
  ['choix', `<div class="ct-choice__backdrop"><div class="ct-choice">${items}</div></div>`, '.ct-choice'],
  ['date', `<div class="ct-date-prompt__backdrop"><div class="ct-date-prompt__modal">${items}</div></div>`, '.ct-date-prompt__modal'],
  ['sauvegardes', `<div class="ct-backup__backdrop"><div class="ct-backup">${items}</div></div>`, '.ct-backup'],
  ['export', `<div class="ct-export__backdrop"><div class="ct-export">${items}</div></div>`, '.ct-export'],
  ['bienvenue', `<div class="ct-onboarding" data-layout="phone"><div class="ct-onboarding__panel">${items}</div></div>`, '.ct-onboarding__panel'],
] as const) {
  test(`UI-FIX-02 : ${name}, le conteneur défilant est borné par les zones sûres`, async ({ page }) => {
    await page.setContent(`${viewport}<style>${styles}\nhtml,body{margin:0;height:100%}:root{--ct-safe-area-top:59px;--ct-safe-area-bottom:34px}</style>${content}`);
    const bounds = await page.locator(selector).boundingBox();
    expect(bounds?.y).toBeGreaterThanOrEqual(59);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()!.height - 34);
  });
}

test('UI-FIX-02 : une feuille longue ne défile jamais dans l’encoche', async ({ page }) => {
  await page.setContent(`${viewport}<style>${styles}\nhtml,body{margin:0;height:100%}:root{--ct-safe-area-top:59px;--ct-safe-area-bottom:34px}</style><div class="ct-sheet__backdrop"><section class="ct-sheet ct-sheet--tall"><h1>Détail</h1>${items}</section></div>`);
  const sheet = page.locator('section');
  expect((await sheet.boundingBox())?.y).toBeGreaterThanOrEqual(59);
  await sheet.evaluate((el) => { el.scrollTop = 300; });
  expect((await sheet.boundingBox())?.y).toBeGreaterThanOrEqual(59);
});

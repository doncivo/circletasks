import { expect, test, type Page } from '@playwright/test';
import { addIsoDays, browserToday } from './helpers/schedule';
import { openToday, todayTab } from './helpers/today';

/**
 * PERF-01 — mesures de temps d'affichage (PRD 8), projet `perf` seulement (tag @perf), comme S-01 : Aujourd'hui avec 5 000 tâches en base
 * (A-01, < 300 ms) et rapport du mois (H-01, < 300 ms une fois le bloc Recharts chargé). Chaque mesure est prise dans la page, du clic
 * à l'élément attendu, cinq fois ; la MÉDIANE des cinq essais est comparée au seuil (pas le minimum, qui cacherait une lenteur
 * ordinaire). Le premier affichage du rapport, qui charge le bloc Recharts à la demande, est mesuré à part et noté dans l'annotation
 * « mesure » sans seuil : en développement il inclut la transformation du module par Vite, bien plus lente que l'installeur.
 * La mesure sans concurrence est celle de `npm run test:perf` (Vitest, mémoire).
 */
const THRESHOLD_MS = 300;
const ATTEMPTS = 5;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};
const ms = (values: readonly number[]): string => values.map((value) => String(Math.round(value))).join(' / ');

/** Du clic sur `trigger` (sélecteur d'un bouton) jusqu'à l'apparition de `ready` (sélecteur CSS) dans la page. */
async function measureClickToVisible(page: Page, trigger: { readonly name: string; readonly inNav: boolean }, ready: string): Promise<number> {
  return page.evaluate(
    async ([name, inNav, selector]) => {
      const scope: ParentNode = inNav ? (document.querySelector('nav') ?? document) : document;
      const button = [...scope.querySelectorAll('button')].find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent).trim() === name) as HTMLElement | undefined;
      if (!button) throw new Error(`bouton introuvable : ${name}`);
      const start = performance.now();
      button.click();
      await new Promise<void>((resolve) => {
        if (document.querySelector(selector)) return resolve();
        const observer = new MutationObserver(() => {
          if (document.querySelector(selector)) {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      return performance.now() - start;
    },
    [trigger.name, trigger.inNav, ready] as const,
  );
}

const leaveToSettings = async (page: Page): Promise<void> => {
  await page.getByRole('navigation').getByRole('button', { name: 'Réglages', exact: true }).click();
  await page.waitForTimeout(400);
};

test.describe('PERF-01 — temps d’affichage avec 5 000 tâches', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('Aujourd’hui s’affiche en moins de 300 ms avec 5 000 tâches en base, médiane de 5 essais (A-01) @perf', async ({ page }, testInfo) => {
    const today = await browserToday(page);
    // 5 000 tâches sur 100 jours autour d'aujourd'hui : 50 tâches dans la liste du jour.
    await page.evaluate(([first]) => window.__ctTest?.seedTasks(5000, first ?? '', 100), [addIsoDays(today, -50)] as const);
    const timings: number[] = [];
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      await leaveToSettings(page);
      timings.push(await measureClickToVisible(page, { name: 'Tâches', inNav: true }, '.ct-today__list .ct-list-row'));
    }
    const value = median(timings);
    testInfo.annotations.push({ type: 'mesure', description: `médiane ${String(Math.round(value))} ms (essais : ${ms(timings)} ms)` });
    expect(value).toBeLessThan(THRESHOLD_MS);
    await expect(todayTab(page)).toBeVisible();
    expect(await page.locator('.ct-today__list .ct-list-row').count()).toBeGreaterThan(0);
  });

  test('le rapport du mois s’affiche en moins de 300 ms une fois le bloc Recharts chargé, médiane de 5 essais (H-01, H-02) @perf', async ({ page }, testInfo) => {
    const today = await browserToday(page);
    // 5 000 tâches sur trois ans (≈ 4,5 par jour, ≈ 140 dans le mois courant).
    await page.evaluate(([first]) => window.__ctTest?.seedTasks(5000, first ?? '', 1095), [addIsoDays(today, -1095)] as const);
    const chart = '.ct-stats__chart .ct-stats__bar';
    const open = (): Promise<number> => measureClickToVisible(page, { name: 'Rapport mensuel', inNav: false }, chart);

    // Premier affichage : charge le bloc Recharts à la demande (noté, sans seuil).
    const first = await open();
    const timings: number[] = [];
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      await todayTab(page).click();
      await expect(page.getByRole('button', { name: 'Rapport mensuel' })).toBeVisible();
      await page.waitForTimeout(400);
      timings.push(await open());
    }
    const value = median(timings);
    testInfo.annotations.push({ type: 'mesure', description: `premier affichage (bloc Recharts compris) ${String(Math.round(first))} ms ; ensuite médiane ${String(Math.round(value))} ms (essais : ${ms(timings)} ms)` });
    expect(value).toBeLessThan(THRESHOLD_MS);
    await expect(page.getByTestId('month-rate')).toBeVisible();
  });
});

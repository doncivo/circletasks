import type { Locator, Page } from '@playwright/test';

/**
 * Aides e2e du sélecteur de date (T-14) : sur PC, saisie libre dans le champ « Date » ; sur iPhone,
 * roues jour / heures / minutes réglées au clavier (rôle spinbutton, flèche haut = élément suivant).
 */

/** Date locale du navigateur (fuseau simulé de Playwright) au format ISO, 'YYYY-MM-DD'. */
export async function browserToday(page: Page): Promise<string> {
  return page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
}

/** Écart en jours entre deux dates ISO (arithmétique UTC, sans effet de fuseau). */
export function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Date ISO `days` jours après `from`. */
export function addIsoDays(from: string, days: number): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Libellé court d'un jour tel que le produit l'affiche (« mar. 15 janv. »). */
export function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

async function press(page: Page, wheel: Locator, key: string, times: number): Promise<void> {
  if (times <= 0) return;
  await wheel.focus();
  for (let i = 0; i < times; i += 1) await page.keyboard.press(key);
}

/** iPhone : règle les roues de `scope` (feuille « Nouvelle tâche » ou « Choisir une date ») sur la date et l'heure voulues. */
export async function setWheels(page: Page, scope: Locator, target: { date?: string; time?: string }): Promise<void> {
  if (target.date) {
    const diff = dayDiff(await browserToday(page), target.date);
    await press(page, scope.getByRole('spinbutton', { name: 'Jour' }), diff >= 0 ? 'ArrowUp' : 'ArrowDown', Math.abs(diff));
  }
  if (target.time) {
    const [hour, minute] = target.time.split(':').map(Number);
    await press(page, scope.getByRole('spinbutton', { name: 'Heures' }), 'ArrowUp', (hour ?? 0) + 1);
    await press(page, scope.getByRole('spinbutton', { name: 'Minutes' }), 'ArrowUp', Math.round((minute ?? 0) / 5));
  }
}

/** PC : saisie libre dans le champ « Date » de la saisie rapide (validée au départ du champ). */
export async function typeDate(scope: Page | Locator, text: string): Promise<void> {
  const field = scope.getByRole('combobox', { name: 'Date' });
  await field.fill(text);
  await field.press('Enter');
}

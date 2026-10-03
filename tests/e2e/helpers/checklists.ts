import { expect, type Locator, type Page } from '@playwright/test';

/** Aides e2e de l'onglet Checklists (C-01 à C-05), communes aux projets `pc` et `iphone`. */

export const checklistsTab = (page: Page): Locator => page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Checklists', exact: true });

/** Ouvre l'onglet Checklists (iPhone : titre de la checklist affichée ou « Checklists » ; PC : volet gauche). */
export async function openChecklists(page: Page): Promise<void> {
  await checklistsTab(page).click();
  await expect(page.locator('.ct-checklists')).toBeVisible();
}

/** Rouvre l'onglet après des insertions en base (passe par Aujourd'hui : l'écran se recharge à son ouverture). */
export async function reopenChecklists(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Tâches', exact: true }).click();
  await openChecklists(page);
}

export interface DirectChecklist {
  readonly title: string;
  readonly space?: 'pro' | 'perso';
  readonly icon?: string;
  /** Date ISO associée (C-03). */
  readonly date?: string;
  readonly template?: boolean;
  /** Textes des items dans l'ordre ; `[texte, true]` : coché ; `[texte, 'deleted']` : supprimé logiquement. */
  readonly items?: readonly (string | readonly [string, boolean | 'deleted'])[];
}

let sequence = 0;

/** Pose des checklists et leurs items en base (prise de test du navigateur de développement) ; à appeler avant d'ouvrir l'écran. */
export async function insertChecklists(page: Page, items: readonly DirectChecklist[]): Promise<void> {
  const base = sequence;
  sequence += items.length * 1000;
  await page.evaluate(
    async ([lists, offset]) => {
      const hooks = window.__ctTest;
      if (!hooks) throw new Error('prise de test absente (navigateur de développement uniquement)');
      const stamp = '2026-01-01T08:00:00.000Z';
      let order = 0;
      for (const list of lists) {
        order += 1;
        const n = offset + order * 1000;
        const id = `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        await hooks.execute(
          `INSERT INTO checklist (id, space_id, title, icon, date, is_template, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'e2e', ?)`,
          [
            id,
            list.space === 'perso' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001',
            list.title,
            list.icon ?? null,
            list.date ?? null,
            list.template ? 1 : 0,
            stamp,
            stamp,
            `00000000${String(n).padStart(7, '0')}-0000-e2e`,
          ],
        );
        let itemOrder = 0;
        for (const entry of list.items ?? []) {
          itemOrder += 1;
          const [text, state] = typeof entry === 'string' ? [entry, false] : entry;
          await hooks.execute(
            `INSERT INTO checklist_item (id, checklist_id, text, checked, sort_order, created_at, updated_at, deleted_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'e2e', ?)`,
            [
              `92000000-0000-4000-8000-${String(n + itemOrder).padStart(12, '0')}`,
              id,
              text,
              state === true ? 1 : 0,
              itemOrder,
              stamp,
              stamp,
              state === 'deleted' ? stamp : null,
              `10000000${String(n + itemOrder).padStart(7, '0')}-0000-e2e`,
            ],
          );
        }
      }
    },
    [items, base] as const,
  );
}

/** Champ « Nouvel élément ». */
export const addField = (page: Page): Locator => page.getByLabel('Nouvel élément');

/** Items de la checklist affichée (cartes grises), dans l'ordre. */
export const itemRows = (page: Page): Locator => page.locator('.ct-checklist-item');

export async function itemTexts(page: Page): Promise<string[]> {
  return page.locator('.ct-checklist-item__text').allTextContents();
}

/** Ouvre une checklist dans la liste : volet gauche (PC) ou pastille de choix (iPhone). */
export async function chooseChecklist(page: Page, testInfo: { project: { name: string } }, title: string): Promise<void> {
  if (testInfo.project.name === 'iphone') {
    const chooser = page.getByRole('combobox', { name: 'Choisir une checklist' });
    const option = chooser.locator('option').filter({ hasText: title }).first();
    await chooser.selectOption(await option.getAttribute('value'));
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    return;
  }
  await page.getByRole('list', { name: 'Mes checklists' }).getByRole('button', { name: new RegExp(`^${title}`) }).click();
  await expect(page.getByRole('heading', { level: 2, name: title, exact: true })).toBeVisible();
}

/** Crée une checklist par l'interface : « + » (iPhone) ou « + Nouvelle checklist » (PC) puis la feuille. */
export async function createChecklist(page: Page, testInfo: { project: { name: string } }, title: string, space?: 'Pro' | 'Perso'): Promise<void> {
  await page.getByRole('button', { name: testInfo.project.name === 'iphone' ? 'Nouvelle checklist' : '+ Nouvelle checklist', exact: true }).click();
  const form = page.getByRole('form', { name: 'Nouvelle checklist' });
  await form.getByLabel('Titre de la checklist').fill(title);
  if (space) await form.getByRole('button', { name: space, exact: true }).click();
  await form.getByRole('button', { name: 'Créer' }).click();
  await expect(form).not.toBeVisible();
}

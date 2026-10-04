import { expect, test, type Page } from '@playwright/test';
import { emptyStateScreens } from '../../src/features/app/emptyStateScreens';
import { fr } from '../../src/i18n/fr';
import { openApp } from './helpers/app';
import { openRoutines } from './helpers/routines';
import { openSomeday } from './helpers/someday';
import { isPhone, todayTab } from './helpers/today';
import { weekTab } from './helpers/week';
import { checklistsTab } from './helpers/checklists';
import { disableHolidays, eventsTab } from './helpers/events';

/**
 * P-06 — un écran vide m'indique quoi faire. Balayage du registre `emptyStateScreens` sur base vide : PC et iPhone, thèmes clair et
 * sombre, filtres Tout / Pro / Perso. Chaque écran affiche un titre de niveau 2 et une action visible de 44 pt au moins.
 */
type Info = { project: { name: string } };

async function openDone(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Rapport mensuel' }).click();
  await page.getByRole('button', { name: 'Tâches terminées' }).click();
  await expect(page.getByRole('heading', { name: 'Tâches terminées', level: 1 })).toBeVisible();
}

async function openTrash(page: Page): Promise<void> {
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await page.getByRole('button', { name: 'Ouvrir la corbeille' }).click();
  await expect(page.getByRole('heading', { name: 'Corbeille', level: 1 })).toBeVisible();
}

const openers: Record<string, (page: Page, info: Info) => Promise<void>> = {
  today: async (page) => {
    await todayTab(page).click();
  },
  week: async (page) => {
    await weekTab(page).click();
  },
  routines: async (page) => openRoutines(page),
  routinesMonth: async (page) => {
    await openRoutines(page);
    await page.getByRole('button', { name: 'Rapport du mois' }).click();
  },
  events: async (page) => {
    await disableHolidays(page);
    await eventsTab(page).click();
  },
  checklists: async (page) => {
    await checklistsTab(page).click();
  },
  someday: async (page, info) => openSomeday(page, info),
  done: async (page) => openDone(page),
  trash: async (page) => openTrash(page),
};

test('le registre est entièrement couvert par le balayage', () => {
  expect(Object.keys(openers).sort()).toEqual(emptyStateScreens.map((screen) => screen.id).sort());
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`P-06 — états vides, thème ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    for (const screen of emptyStateScreens) {
      test(`${screen.id} : message et action sur base vide`, async ({ page }, testInfo) => {
        test.skip(screen.id === 'routinesMonth' && !isPhone(testInfo), 'Rapport du mois : bouton iPhone seulement');
        await openApp(page);
        await openers[screen.id]?.(page, testInfo);
        const filters = ['Tout', 'Pro', 'Perso'];
        for (const filter of filters) {
          const pill = page.getByRole('button', { name: filter, exact: true }).first();
          if (await pill.isVisible()) await pill.click();
          const empty = page.locator(`[data-empty-screen="${screen.id}"]`);
          await expect(empty).toBeVisible();
          await expect(empty.getByRole('heading', { level: 2 })).toBeVisible();
          const label = screen.actionKey
            .split('.')
            .slice(1)
            .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], fr.empty) as string;
          const action = empty.getByRole('button', { name: label.replace(' · {count} tâches', ''), exact: false });
          await expect(action).toBeVisible();
          const box = await action.boundingBox();
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
          if (!(await pill.isVisible())) break;
        }
      });
    }
  });
}

test.describe('P-06 — actions', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('Aujourd’hui : « Ajouter une tâche » ouvre la saisie', async ({ page }, testInfo) => {
    await page.locator('[data-empty-screen="today"]').getByRole('button', { name: 'Ajouter une tâche' }).click();
    if (isPhone(testInfo)) await expect(page.getByRole('dialog', { name: 'Nouvelle tâche' })).toBeVisible();
    else await expect(page.getByLabel('Nouvelle tâche')).toBeFocused();
  });

  test('Aujourd’hui : l’état vide disparaît à la première tâche (critère 6)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Saisie en ligne : PC');
    const field = page.getByLabel('Nouvelle tâche');
    await field.fill('Appeler Paul');
    await field.press('Enter');
    await expect(page.locator('[data-empty-screen="today"]')).toHaveCount(0);
  });

  test('Tâches terminées et corbeille : « Aller à Aujourd’hui » ramène à la liste du jour', async ({ page }) => {
    await openDone(page);
    await page.locator('[data-empty-screen="done"]').getByRole('button', { name: 'Aller à Aujourd’hui' }).click();
    await expect(todayTab(page)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-empty-screen="today"]')).toBeVisible();
  });

  test('« Un jour » : « Ajouter à « Un jour » » met le champ en saisie', async ({ page }, testInfo) => {
    await openSomeday(page, testInfo);
    await page.locator('[data-empty-screen="someday"]').getByRole('button', { name: 'Ajouter à « Un jour »' }).click();
    await expect(page.getByRole('textbox', { name: 'Nouvelle tâche sans date' })).toBeFocused();
  });
});

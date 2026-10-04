import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { be32, installFakeFiles, nextFilesMode, onlySaved, revealedPaths, savedFiles, textOf } from './helpers/files';
import { insertFocusSessions } from './helpers/focus';
import { insertGoals } from './helpers/goals';
import { insertRoutines } from './helpers/routines';
import { filterPill } from './helpers/spaces';
import { insertTasks, openReport } from './helpers/stats';
import { isPhone, todayTab } from './helpers/today';

/**
 * H-03 — J'exporte mon historique. Date figée au mer. 23 sept. 2026 ; le service de fichiers est un faux qui garde en mémoire ce qui
 * serait enregistré (la boîte « Enregistrer sous » système n'existe pas dans le navigateur). CSV (BOM, « ; »), JSON, rapport en PDF et en
 * image, filtre d'espace, annulation, échec. Exécuté sur `pc` et `iphone` (le bouton n'apparaît pas si l'enregistrement est impossible).
 */
test.describe('H-03 — export de l’historique', () => {
  async function prepare(page: Page, options: { canSave?: boolean } = {}): Promise<void> {
    await page.clock.setFixedTime(new Date('2026-09-23T08:00:00Z'));
    await installFakeFiles(page, options);
    await openApp(page);
    await insertTasks(page, [
      { title: 'Réunion « équipe »', date: '2026-09-10', time: '09:30', done: true, note: 'ligne 1\nligne "2"; fin' },
      { title: 'Courses', date: '2026-09-12', space: 'perso' },
      { title: 'Sans date' },
      { title: 'Août', date: '2026-08-12', done: true },
    ]);
    await insertGoals(page, [{ title: 'Finir le dossier', weekStart: '2026-09-07', status: 'achieved' }]);
    await insertFocusSessions(page, [{ startedAt: '2026-09-10T08:00:00.000Z', minutes: 25 }]);
    await insertRoutines(page, [{ title: 'Faire mon lit', space: 'pro', startDate: '2026-09-20', done: ['2026-09-20'] }]);
    await todayTab(page).click();
    await openReport(page, 'septembre');
  }

  async function openDialog(page: Page) {
    await page.getByRole('button', { name: 'Exporter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Exporter l’historique' });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('critère 1 : fenêtre (PC) ou feuille (iPhone) avec contenu, période, filtre et avertissement', async ({ page }, testInfo) => {
    await prepare(page);
    const dialog = await openDialog(page);
    if (isPhone(testInfo)) await expect(dialog).toHaveClass(/ct-sheet/);
    for (const label of ['Historique en CSV', 'Historique en JSON', 'Rapport du mois en PDF', 'Rapport du mois en image', 'Tout l’historique', 'Mois affiché']) {
      await expect(dialog.getByRole('radio', { name: label })).toBeVisible();
    }
    await expect(dialog.getByText('Filtre : Tout')).toBeVisible();
    await expect(dialog.getByText(/n’est pas chiffré/)).toBeVisible();
  });

  test('critère 2 : CSV « ; » en UTF-8 avec BOM, en-têtes, une ligne par tâche, guillemets doublés, notes sur plusieurs lignes', async ({ page }) => {
    await prepare(page);
    const dialog = await openDialog(page);
    await dialog.getByRole('button', { name: 'Exporter', exact: true }).click();
    await expect(page.getByText('Historique exporté')).toBeVisible();
    const file = await onlySaved(page);
    expect(file.name).toBe('circletasks-taches-2026-09-23.csv');
    expect(file.bytes.slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
    const text = textOf(file);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('titre;date;heure;espace;projet;note;statut;termine_le;objectif;repetition');
    expect(text).toContain('Réunion « équipe »;2026-09-10;09:30;Pro;;"ligne 1\nligne ""2""; fin";fait;2026-09-10;;');
    expect(text).toContain('Courses;2026-09-12;;Perso;;;à faire;;;');
    expect(text).toContain('Sans date;;;Pro;;;à faire;;;');
    expect(lines.filter((line) => line !== '')).toHaveLength(5); // en-tête et 4 tâches (le retour à la ligne de la note reste dans sa cellule)
  });

  test('critère 2 : période « Mois affiché » limite aux tâches datées du mois', async ({ page }) => {
    await prepare(page);
    const dialog = await openDialog(page);
    await dialog.getByRole('radio', { name: 'Mois affiché' }).check();
    await dialog.getByRole('button', { name: 'Exporter', exact: true }).click();
    await expect(page.getByText('Historique exporté')).toBeVisible();
    const text = textOf(await onlySaved(page));
    expect(text).toContain('Courses');
    expect(text).not.toContain('Sans date');
    expect(text).not.toContain('Août');
  });

  test('critère 3 : JSON { schema_version, exported_at, filter, tasks, routines, focus_sessions, goals }', async ({ page }) => {
    await prepare(page);
    const dialog = await openDialog(page);
    await dialog.getByRole('radio', { name: 'Historique en JSON' }).check();
    await dialog.getByRole('button', { name: 'Exporter', exact: true }).click();
    await expect(page.getByText('Historique exporté')).toBeVisible();
    const file = await onlySaved(page);
    expect(file.name).toBe('circletasks-historique-2026-09-23.json');
    const json = JSON.parse(textOf(file)) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(['schema_version', 'exported_at', 'filter', 'tasks', 'routines', 'focus_sessions', 'goals']);
    expect(json['schema_version']).toBe(1);
    expect(String(json['exported_at'])).toMatch(/^2026-09-23T/);
    expect((json['tasks'] as unknown[]).length).toBe(4);
    expect(((json['routines'] as { logs: unknown[] }[])[0])?.logs).toHaveLength(1);
    expect(json['focus_sessions']).toHaveLength(1);
    expect(json['goals']).toHaveLength(1);
  });

  test('critère 4 : sous Pro, seuls les éléments Pro sont exportés et le nom reçoit -pro', async ({ page }) => {
    await prepare(page);
    await filterPill(page, 'Pro').click();
    const dialog = await openDialog(page);
    await expect(dialog.getByText('Filtre : Pro')).toBeVisible();
    await dialog.getByRole('button', { name: 'Exporter', exact: true }).click();
    await expect(page.getByText('Historique exporté')).toBeVisible();
    const file = await onlySaved(page);
    expect(file.name).toBe('circletasks-taches-2026-09-23-pro.csv');
    expect(textOf(file)).not.toContain('Courses');
    expect(textOf(file)).toContain('Réunion');
  });

  test('critère 5 : rapport en PDF — une page A4, image JPEG, nom circletasks-rapport-2026-09.pdf', async ({ page }) => {
    await prepare(page);
    const dialog = await openDialog(page);
    await dialog.getByRole('radio', { name: 'Rapport du mois en PDF' }).check();
    await dialog.getByRole('button', { name: 'Exporter', exact: true }).click();
    await expect(page.getByText('Historique exporté')).toBeVisible();
    const file = await onlySaved(page);
    expect(file.name).toBe('circletasks-rapport-2026-09.pdf');
    expect(file.mime).toBe('application/pdf');
    const raw = new TextDecoder('latin1').decode(new Uint8Array(file.bytes));
    expect(raw.startsWith('%PDF-1.4')).toBe(true);
    expect(raw).toContain('/MediaBox [0 0 595 842]');
    expect(raw).toContain('/Count 1');
    expect(raw).toContain('/Filter /DCTDecode');
    expect(raw).toContain('/Width 1080');
  });

  test('critère 6 : rapport en image — PNG de 1 080 px de large, nom circletasks-rapport-2026-09.png', async ({ page }) => {
    await prepare(page);
    const dialog = await openDialog(page);
    await dialog.getByRole('radio', { name: 'Rapport du mois en image' }).check();
    await dialog.getByRole('button', { name: 'Exporter', exact: true }).click();
    await expect(page.getByText('Historique exporté')).toBeVisible();
    const file = await onlySaved(page);
    expect(file.name).toBe('circletasks-rapport-2026-09.png');
    const bytes = file.bytes;
    expect(bytes.slice(0, 8)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const width = be32(bytes, 16);
    const height = be32(bytes, 20);
    expect(width).toBe(1080);
    expect(height).toBeGreaterThan(500);
  });

  test('critère 7 : annuler la boîte système n’affiche aucune erreur ; « Afficher dans le dossier » après un enregistrement', async ({ page }) => {
    await prepare(page);
    const dialog = await openDialog(page);
    await nextFilesMode(page, 'cancel');
    await dialog.getByRole('button', { name: 'Exporter', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Exporter', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await savedFiles(page)).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Exporter', exact: true }).click();
    await expect(page.getByText('Historique exporté')).toBeVisible();
    await page.getByRole('button', { name: 'Afficher dans le dossier' }).click();
    expect(await revealedPaths(page)).toEqual(['C:\\Export\\circletasks-taches-2026-09-23.csv']);
  });

  test('critère 9 : un échec affiche un message clair et n’enregistre rien', async ({ page }) => {
    await prepare(page);
    const dialog = await openDialog(page);
    await nextFilesMode(page, 'fail');
    await dialog.getByRole('button', { name: 'Exporter', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('L’export a échoué');
    expect(await savedFiles(page)).toHaveLength(0);
  });

  test('critère 10 : sans enregistrement possible, le bouton « Exporter » n’apparaît pas', async ({ page }) => {
    await prepare(page, { canSave: false });
    await expect(page.getByRole('button', { name: 'Exporter', exact: true })).toHaveCount(0);
  });

  test('critère 11 : aucune requête réseau pendant l’export', async ({ page }) => {
    await prepare(page);
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://localhost') && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
    });
    const dialog = await openDialog(page);
    await dialog.getByRole('button', { name: 'Exporter', exact: true }).click();
    await expect(page.getByText('Historique exporté')).toBeVisible();
    expect(external).toEqual([]);
  });
});

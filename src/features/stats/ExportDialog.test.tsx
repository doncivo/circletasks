import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { createMemoryFiles, type MemoryFiles } from '../../platform/files';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { createAppContainer } from '../app/container';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { ReportScreen } from './ReportScreen';

let counter = 0;
async function task(h: TodayHarness, title: string, date: string, space: string = SPACE_PRO_ID): Promise<void> {
  counter += 1;
  await h.db.driver.execute(
    "INSERT INTO task (id, space_id, title, date, status, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, 'todo', 1, 'z', 'z', 'd', 'h')",
    [`72000000-0000-4000-8000-${String(counter).padStart(12, '0')}`, space, title, date],
  );
}

describe('Fenêtre « Exporter l’historique » (H-03)', () => {
  // Recharts est chargé à la demande : on le charge une fois avant les tests (la transformation à froid peut dépasser les délais).
  beforeAll(async () => {
    await import('./CompletionChart');
  }, 60_000);

  let h: TodayHarness;
  let files: MemoryFiles;

  beforeEach(async () => {
    counter = 0;
    mockViewport(1440);
    h = await setupToday(`8${String(Math.floor(Math.random() * 9000) + 1000)}`, '2026-09-23T10:00:00.000Z');
    files = createMemoryFiles();
    await task(h, 'Envoyer la facture', '2026-09-10');
  });
  afterEach(async () => {
    await teardownToday(h);
    cleanup();
  });

  function renderReport(withFiles = files) {
    const container = createAppContainer({ ...h.container, files: withFiles });
    return render(
      <AppContainerProvider container={container}>
        <ReportScreen />
      </AppContainerProvider>,
    );
  }

  async function openDialog() {
    fireEvent.click(await screen.findByRole('button', { name: 'Exporter' }));
    return screen.findByRole('dialog', { name: 'Exporter l’historique' });
  }

  it('critère 1 : contenu (CSV, JSON, PDF, image), période pour CSV et JSON, rappel du filtre, avertissement', async () => {
    renderReport();
    const dialog = await openDialog();
    const content = within(dialog).getByRole('group', { name: 'Contenu' });
    expect(within(content).getAllByRole('radio').map((radio) => radio.parentElement?.textContent)).toEqual([
      'Historique en CSV',
      'Historique en JSON',
      'Rapport du mois en PDF',
      'Rapport du mois en image',
    ]);
    const period = within(dialog).getByRole('group', { name: 'Période' });
    expect(within(period).getByRole('radio', { name: 'Tout l’historique' })).toBeChecked();
    expect(within(period).getByRole('radio', { name: 'Mois affiché' })).not.toBeChecked();
    expect(within(dialog).getByText('Filtre : Tout')).toBeInTheDocument();
    expect(within(dialog).getByText(/n’est pas chiffré/)).toBeInTheDocument();
    fireEvent.click(within(content).getByRole('radio', { name: 'Rapport du mois en PDF' }));
    expect(within(dialog).queryByRole('group', { name: 'Période' })).toBeNull();
  });

  it('critères 2 et 7 : « Exporter » propose circletasks-taches-AAAA-MM-JJ.csv, message « Historique exporté » et « Afficher dans le dossier »', async () => {
    renderReport();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exporter' }));
    expect(await screen.findByText('Historique exporté')).toBeInTheDocument();
    expect(files.saved).toHaveLength(1);
    expect(files.saved[0]?.suggestedName).toBe('circletasks-taches-2026-09-23.csv');
    expect(files.saved[0]?.mime).toContain('text/csv');
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(files.saved[0]?.data)).toContain('Envoyer la facture;2026-09-10');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Afficher dans le dossier' }));
    expect(files.revealed).toEqual(['C:\\Export\\circletasks-taches-2026-09-23.csv']);
  });

  it('critère 3 : JSON du mois affiché, nom circletasks-historique-…json', async () => {
    renderReport();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Historique en JSON' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Mois affiché' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exporter' }));
    await screen.findByText('Historique exporté');
    expect(files.saved[0]?.suggestedName).toBe('circletasks-historique-2026-09-23.json');
    const json = JSON.parse(new TextDecoder().decode(files.saved[0]?.data)) as { schema_version: number; filter: { period: { kind: string } }; tasks: unknown[] };
    expect(json.schema_version).toBe(1);
    expect(json.filter.period.kind).toBe('month');
    expect(json.tasks).toHaveLength(1);
  });

  it('critère 4 : sous Pro, le nom reçoit le suffixe -pro et le rappel indique le filtre', async () => {
    useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
    renderReport();
    const dialog = await openDialog();
    expect(within(dialog).getByText('Filtre : Pro')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exporter' }));
    await screen.findByText('Historique exporté');
    expect(files.saved[0]?.suggestedName).toBe('circletasks-taches-2026-09-23-pro.csv');
  });

  it('critère 7 : annuler la boîte « Enregistrer sous » n’affiche aucune erreur et laisse la fenêtre ouverte', async () => {
    renderReport();
    const dialog = await openDialog();
    files.cancelNext();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exporter' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Exporter' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Historique exporté')).toBeNull();
    expect(files.saved).toHaveLength(0);
  });

  it('critère 9 : un échec affiche un message clair, rien n’est enregistré', async () => {
    renderReport();
    const dialog = await openDialog();
    files.failNext();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exporter' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('L’export a échoué');
    expect(files.saved).toHaveLength(0);
    expect(screen.queryByText('Historique exporté')).toBeNull();
  });

  it('critère 10 : sans enregistrement de fichier possible (iPhone), le bouton « Exporter » n’apparaît pas', async () => {
    renderReport(createMemoryFiles({ canSave: false }));
    await screen.findByRole('heading', { level: 1, name: 'septembre' });
    await screen.findByRole('group', { name: 'Chiffres du mois' });
    expect(screen.queryByRole('button', { name: 'Exporter' })).toBeNull();
  });

  it('iPhone : la même fenêtre s’ouvre en feuille', async () => {
    mockViewport(440);
    renderReport();
    const dialog = await openDialog();
    expect(dialog.className).toContain('ct-sheet');
    expect(within(dialog).getByRole('radio', { name: 'Historique en CSV' })).toBeChecked();
  });
});

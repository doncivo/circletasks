import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../../db/seed/defaultSpaces';
import { addDays } from '../../../domain/localDate';
import { formatDayLabel } from '../../../i18n/format';
import { createFakeOcr, type FakeOcr } from '../../../platform/ocr/testing';
import type { OcrService } from '../../../platform/ocr';
import { AppContainerProvider } from '../../app/AppContainerContext';
import { UndoToast } from '../../app/UndoToast';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../../today/testKit';
import { ScanDialog } from './ScanDialog';

/** Scan de tâches de bout en bout dans jsdom, avec des faux moteurs (aucune image réelle : voir les images de test dans tests/fixtures/ocr). */
const SCAN_HTML_LINES = ['- plombier', '- ampoules', '- resto samedi', '- cantine', '- garage ?'];

describe('scan de tâches (Q-04)', () => {
  let h: TodayHarness;
  let native: FakeOcr;
  let embedded: FakeOcr;
  let closed: number;

  const service = (overrides: Partial<OcrService> = {}): OcrService => ({ primary: native, fallback: embedded, dispose: () => Promise.resolve(), ...overrides });
  const png = (name = 'liste.png', type = 'image/png', size = 1_000): File => new File([new Uint8Array(size)], name, { type });

  function open(svc: OcrService = service()) {
    return render(
      <AppContainerProvider container={h.container}>
        <ScanDialog onClose={() => (closed += 1)} service={svc} />
        <UndoToast />
      </AppContainerProvider>,
    );
  }
  const fileInput = (): HTMLInputElement => screen.getByLabelText('Choisir une image');
  const upload = (file: File): void => {
    fireEvent.change(fileInput(), { target: { files: [file] } });
  };
  const review = async (): Promise<void> => {
    upload(png());
    await screen.findByRole('heading', { name: 'Relecture' });
  };

  beforeEach(async () => {
    mockViewport(1440);
    closed = 0;
    // Mercredi 23 septembre 2026, 10:00 à Paris (dates des maquettes).
    h = await setupToday('b105', '2026-09-23T08:00:00.000Z');
    native = createFakeOcr({ id: 'windows', lines: SCAN_HTML_LINES.map((text) => ({ text })) });
    embedded = createFakeOcr({ id: 'tesseract', lines: [{ text: 'Lu par le repli', confidence: 90 }] });
  });
  afterEach(async () => {
    cleanup();
    await teardownToday(h);
  });

  describe('source', () => {
    it('fenêtre « Scan tâches » : importer une image, webcam, dépôt (critère 2)', async () => {
      open();
      expect(await screen.findByRole('dialog', { name: 'Scan tâches' })).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Importer une image' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Utiliser la webcam' })).toBeInTheDocument();
      expect(screen.getByText('Déposez une image ici')).toBeInTheDocument();
      expect(screen.getByText('JPEG, PNG ou WebP, 10 Mo au plus')).toBeInTheDocument();
      expect(fileInput()).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
      expect(native.statusCalls).toBe(1);
    });

    it('refuse HEIC, trop lourd et format inconnu avec un message, sans lire', async () => {
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      upload(png('IMG.heic', 'image/heic'));
      expect(await screen.findByRole('alert')).toHaveTextContent('Les photos HEIC ne sont pas lues. Exportez-les en JPEG ou en PNG.');
      upload(png('gros.png', 'image/png', 10 * 1024 * 1024 + 1));
      expect(await screen.findByText('Cette image est trop lourde (10 Mo au plus).')).toBeInTheDocument();
      upload(png('note.pdf', 'application/pdf'));
      expect(await screen.findByText('Format non pris en charge. Choisissez une image JPEG, PNG ou WebP.')).toBeInTheDocument();
      expect(native.received).toEqual([]);
    });

    it('le glisser-déposer d’une image sur la fenêtre est accepté', async () => {
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      fireEvent.drop(screen.getByRole('dialog', { name: 'Scan tâches' }), { dataTransfer: { files: [png()] } });
      await screen.findByRole('heading', { name: 'Relecture' });
      expect(native.received).toHaveLength(1);
    });

    it('iPhone : sélecteur du système, pas de webcam (critère 13)', async () => {
      mockViewport(440);
      open(service({ primary: null }));
      expect(await screen.findByRole('button', { name: 'Prendre ou choisir une photo' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Utiliser la webcam' })).toBeNull();
      expect(fileInput()).toHaveAttribute('accept', 'image/*');
      // Sans moteur natif, pas de vérification de pack : le repli lit.
      upload(png());
      await screen.findByRole('heading', { name: 'Relecture' });
      expect(embedded.received).toHaveLength(1);
      expect(screen.getByRole('textbox', { name: 'Tâche 1' })).toHaveValue('Lu par le repli');
    });
  });

  describe('lecture et relecture', () => {
    it('« Lecture en cours », puis l’écran Relecture de Scan.html : 5 lignes détectées (critères 3 et 4)', async () => {
      native.delayMs = 60;
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      upload(png());
      expect(await screen.findByRole('heading', { name: 'Lecture en cours' })).toBeInTheDocument();
      await screen.findByRole('heading', { name: 'Relecture' });
      expect(screen.getByText('5 lignes détectées')).toBeInTheDocument();
      expect(screen.getByText('Corrigez le texte, décochez ce qu’il ne faut pas créer, puis validez.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reprendre la photo' })).toBeInTheDocument();
      const inputs = [1, 2, 3, 4, 5].map((n) => screen.getByRole('textbox', { name: `Tâche ${n}` }));
      expect(inputs.map((input) => (input as HTMLInputElement).value)).toEqual(['plombier', 'ampoules', 'resto samedi', 'cantine', 'garage ?']);
      expect(screen.getByRole('button', { name: 'Créer 4 tâches' })).toBeEnabled();
    });

    it('la photo n’est ni enregistrée ni envoyée : aucune URL blob, aucun stockage (critère 3)', async () => {
      const blobUrl = vi.spyOn(URL, 'createObjectURL');
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      expect(blobUrl).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
      expect(native.received).toHaveLength(1);
    });

    it('cases : cochées sauf la ligne incertaine, aria-pressed et libellés (critères 7 et 14)', async () => {
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      const checks = screen.getAllByRole('button', { name: /Créer cette tâche|Ne pas créer cette tâche/ });
      expect(checks).toHaveLength(5);
      expect(checks.map((check) => check.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true', 'true', 'false']);
      expect(checks.map((check) => check.getAttribute('aria-label'))).toEqual(['Créer cette tâche', 'Créer cette tâche', 'Créer cette tâche', 'Créer cette tâche', 'Ne pas créer cette tâche']);
      // Ligne douteuse : texte et icône, pas la couleur seule.
      const row = screen.getByRole('textbox', { name: 'Tâche 5' }).closest('li') as HTMLElement;
      expect(within(row).getByText('Lecture incertaine, à vérifier')).toBeInTheDocument();
      expect(row.querySelector('svg')).not.toBeNull();
      expect(row).toHaveAttribute('data-uncertain', 'true');
      expect(screen.getByRole('textbox', { name: 'Tâche 5' })).toHaveAccessibleDescription('Lecture incertaine, à vérifier');
    });

    it('« resto samedi » : « Date détectée : sam. 26 sept. » (critère 6)', async () => {
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      const row = screen.getByRole('textbox', { name: 'Tâche 3' }).closest('li') as HTMLElement;
      expect(within(row).getByText('Date détectée : sam. 26 sept.')).toBeInTheDocument();
      expect(formatDayLabel(addDays(h.today, 3))).toBe('sam. 26 sept.');
    });

    it('« #pro » et « @projet » sont reconnus et annoncés sous la ligne', async () => {
      native.lines = [{ text: 'Facturer le client #pro' }, { text: 'Courses' }];
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      const row = screen.getByRole('textbox', { name: 'Tâche 1' }).closest('li') as HTMLElement;
      expect(within(row).getByText('Rangée dans : Pro')).toBeInTheDocument();
    });

    it('le bouton compte les lignes cochées et se désactive à 0 (critère 8)', async () => {
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      const toggle = (n: number) => fireEvent.click(screen.getAllByRole('button', { name: /Créer cette tâche|Ne pas créer cette tâche/ })[n - 1] as HTMLElement);
      toggle(1);
      expect(screen.getByRole('button', { name: 'Créer 3 tâches' })).toBeEnabled();
      toggle(5);
      expect(screen.getByRole('button', { name: 'Créer 4 tâches' })).toBeEnabled();
      toggle(2);
      toggle(3);
      toggle(4);
      toggle(5);
      expect(screen.getByRole('button', { name: 'Créer 0 tâche' })).toBeDisabled();
      toggle(2);
      expect(screen.getByRole('button', { name: 'Créer 1 tâche' })).toBeEnabled();
    });

    it('un texte corrigé n’est plus signalé incertain', async () => {
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      fireEvent.change(screen.getByRole('textbox', { name: 'Tâche 5' }), { target: { value: 'Rendez-vous garage' } });
      const row = screen.getByRole('textbox', { name: 'Tâche 5' }).closest('li') as HTMLElement;
      expect(within(row).queryByText('Lecture incertaine, à vérifier')).toBeNull();
      // Toujours décochée : c'est l'utilisateur qui coche.
      expect(screen.getByRole('button', { name: 'Ne pas créer cette tâche' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('valider : tâches créées dans l’espace et le jour choisis, message « 4 tâches créées » et un seul Ctrl+Z (critère 9)', async () => {
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      fireEvent.change(screen.getByRole('textbox', { name: 'Tâche 1' }), { target: { value: 'Appeler le plombier' } });
      fireEvent.click(screen.getByRole('button', { name: 'Pro' }));
      fireEvent.change(screen.getByLabelText('Date des tâches sans date'), { target: { value: 'tomorrow' } });
      fireEvent.click(screen.getByRole('button', { name: 'Créer 4 tâches' }));
      await waitFor(() => expect(closed).toBe(1));
      const tomorrow = await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all');
      expect(tomorrow.map((t) => t.title)).toEqual(['Appeler le plombier', 'ampoules', 'cantine']);
      expect(tomorrow.every((t) => t.spaceId === SPACE_PRO_ID)).toBe(true);
      const saturday = await h.container.data.repos.tasks.listForDay(addDays(h.today, 3), 'all');
      expect(saturday.map((t) => t.title)).toEqual(['resto']);
      expect(await screen.findByText('4 tâches créées')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Annuler' })).toBeInTheDocument();
      await act(async () => {
        await h.container.undo.undoLast();
      });
      expect(await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all')).toEqual([]);
      expect(await h.container.data.repos.tasks.listForDay(addDays(h.today, 3), 'all')).toEqual([]);
    });

    it('espace par défaut : celui du filtre (ES-02), « Un jour » et « Choisir une date »', async () => {
      const { useAppStore } = await import('../../app/appStore');
      useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
      native.lines = [{ text: 'Ranger le garage' }];
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      expect(screen.getByRole('button', { name: 'Perso' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.change(screen.getByLabelText('Date des tâches sans date'), { target: { value: 'someday' } });
      fireEvent.click(screen.getByRole('button', { name: 'Créer 1 tâche' }));
      await waitFor(() => expect(closed).toBe(1));
      const [task] = await h.container.data.repos.tasks.listSomeday('all');
      expect(task).toMatchObject({ title: 'Ranger le garage', spaceId: SPACE_PERSO_ID, date: null, someday: true });
    });

    it('« Choisir une date » ouvre le champ de date et la pose sur les tâches sans date', async () => {
      native.lines = [{ text: 'Ranger le garage' }];
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      fireEvent.change(screen.getByLabelText('Date des tâches sans date'), { target: { value: 'pick' } });
      const date = await screen.findByLabelText('Date choisie');
      fireEvent.change(date, { target: { value: '12/10' } });
      fireEvent.blur(date);
      fireEvent.click(screen.getByRole('button', { name: 'Créer 1 tâche' }));
      await waitFor(() => expect(closed).toBe(1));
      const [task] = await h.container.data.repos.tasks.listForDay(addDays(h.today, 19), 'all');
      expect(task?.title).toBe('Ranger le garage');
    });

    it('« Reprendre la photo » revient au choix de la source sans rien créer (critère 10)', async () => {
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      fireEvent.click(screen.getByRole('button', { name: 'Reprendre la photo' }));
      expect(await screen.findByRole('button', { name: 'Importer une image' })).toBeInTheDocument();
      expect(closed).toBe(0);
      expect(await h.container.data.repos.tasks.listForDay(h.today, 'all')).toEqual([]);
    });

    it('plus de 100 lignes : 100 gardées et un message', async () => {
      native.lines = Array.from({ length: 130 }, (_, i) => ({ text: `Tâche numéro ${i + 1}` }));
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      expect(screen.getByText('100 lignes détectées')).toBeInTheDocument();
      expect(screen.getByText('Seules les 100 premières lignes sur 130 sont gardées.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Créer 100 tâches' })).toBeEnabled();
    });

    it('une image sans texte : « Aucune ligne reconnue » et « Reprendre la photo » (critère 12)', async () => {
      native.lines = [];
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      upload(png());
      expect(await screen.findByRole('heading', { name: 'Aucune ligne reconnue' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Reprendre la photo' }));
      expect(await screen.findByRole('button', { name: 'Importer une image' })).toBeInTheDocument();
    });

    it('échec du moteur : message et reprise, sans rien créer', async () => {
      native.failure = 'failed';
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      upload(png());
      expect(await screen.findByRole('heading', { name: 'La lecture a échoué' })).toBeInTheDocument();
      native.failure = null;
      fireEvent.click(screen.getByRole('button', { name: 'Reprendre la photo' }));
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
    });

    it('Q-04 toutes les lignes décochées : « Créer 0 tâche » est inactif, valider ne crée rien', async () => {
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      for (const button of screen.queryAllByRole('button', { name: 'Créer cette tâche' })) fireEvent.click(button);
      const create = screen.getByRole('button', { name: 'Créer 0 tâche' });
      expect(create).toBeDisabled();
      fireEvent.click(create);
      expect(closed).toBe(0);
      expect(screen.queryByText(/tâches? créées?/)).not.toBeInTheDocument();
      expect(await h.container.data.repos.tasks.listForDay(h.today, 'all')).toEqual([]);
      expect(await h.container.data.repos.tasks.listSomeday('all')).toEqual([]);
    });

    it('Q-04 l’image n’est jamais conservée, même après une erreur ou une image sans texte', async () => {
      const blobUrl = vi.spyOn(URL, 'createObjectURL');
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      native.failure = 'failed';
      upload(png());
      await screen.findByRole('heading', { name: 'La lecture a échoué' });
      native.failure = null;
      native.lines = [];
      fireEvent.click(screen.getByRole('button', { name: 'Reprendre la photo' }));
      await screen.findByRole('button', { name: 'Importer une image' });
      upload(png());
      await screen.findByRole('heading', { name: 'Aucune ligne reconnue' });
      expect(blobUrl).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
    });

    it('Q-04 une ligne très longue et des accents : une ligne = une tâche, texte intact', async () => {
      const long = `Préparer l’été en Côte-d’Azur ${'très '.repeat(120)}fin`;
      native.lines = [{ text: `- ${long}` }, { text: '• Écrire à Zoé' }];
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      upload(png());
      await screen.findByRole('heading', { name: 'Relecture' });
      expect(screen.getByRole('button', { name: 'Créer 2 tâches' })).toBeEnabled();
      expect(screen.getByDisplayValue('Écrire à Zoé')).toBeInTheDocument();
      expect(screen.getByDisplayValue(long)).toBeInTheDocument();
    });
  });

  describe('fermeture', () => {
    it('sans correction, la croix ferme tout de suite ; Échap aussi', async () => {
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      fireEvent.click(screen.getByRole('button', { name: 'Annuler le scan' }));
      expect(closed).toBe(1);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(closed).toBe(2);
    });

    it('après une correction, la fermeture demande confirmation (critère 10)', async () => {
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      await review();
      fireEvent.change(screen.getByRole('textbox', { name: 'Tâche 1' }), { target: { value: 'Appeler le plombier' } });
      fireEvent.click(screen.getByRole('button', { name: 'Annuler le scan' }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Fermer sans créer ?' });
      expect(closed).toBe(0);
      fireEvent.click(within(confirm).getByRole('button', { name: 'Continuer la relecture' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.getByRole('textbox', { name: 'Tâche 1' })).toHaveValue('Appeler le plombier');
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(await within(await screen.findByRole('alertdialog')).findByRole('button', { name: 'Fermer sans créer' }));
      expect(closed).toBe(1);
      expect(await h.container.data.repos.tasks.listForDay(h.today, 'all')).toEqual([]);
    });
  });

  describe('moteur du système indisponible (critère 11)', () => {
    beforeEach(() => {
      native.available = false;
    });

    it('écran « Reconnaissance du texte indisponible » avec la marche à suivre', async () => {
      open();
      expect(await screen.findByRole('heading', { name: 'Reconnaissance du texte indisponible' })).toBeInTheDocument();
      const steps = screen.getByRole('list', { name: 'Marche à suivre' });
      expect(within(steps).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        'Ouvrez Paramètres Windows › Heure et langue › Langue et région.',
        'Choisissez Français › Options de langue.',
        'Installez « Reconnaissance de texte ».',
        'Redémarrez CircleTasks.',
      ]);
      expect(screen.getByRole('button', { name: 'Vérifier de nouveau' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Lire quand même avec le moteur intégré' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Importer une image' })).toBeNull();
    });

    it('« Vérifier de nouveau » : toujours absent, un message ; installé, le choix de l’image s’ouvre', async () => {
      open();
      fireEvent.click(await screen.findByRole('button', { name: 'Vérifier de nouveau' }));
      expect(await screen.findByText('Le pack n’est pas encore détecté. Redémarrez l’application après l’installation.')).toBeInTheDocument();
      native.available = true;
      fireEvent.click(screen.getByRole('button', { name: 'Vérifier de nouveau' }));
      expect(await screen.findByRole('button', { name: 'Importer une image' })).toBeInTheDocument();
      upload(png());
      await screen.findByRole('heading', { name: 'Relecture' });
      expect(native.received).toHaveLength(1);
      expect(embedded.received).toHaveLength(0);
    });

    it('« Lire quand même avec le moteur intégré » lit avec tesseract.js, confiance comprise', async () => {
      embedded.lines = [
        { text: 'Appeler le plombier', confidence: 93 },
        { text: 'Acheter des ampoules', confidence: 41 },
      ];
      open();
      fireEvent.click(await screen.findByRole('button', { name: 'Lire quand même avec le moteur intégré' }));
      await screen.findByRole('button', { name: 'Importer une image' });
      upload(png());
      await screen.findByRole('heading', { name: 'Relecture' });
      expect(embedded.received).toHaveLength(1);
      expect(native.received).toHaveLength(0);
      // Confiance < 60 % : décochée et signalée.
      expect(screen.getAllByRole('button', { name: /Créer cette tâche|Ne pas créer cette tâche/ }).map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
      expect(screen.getByText('Lecture incertaine, à vérifier')).toBeInTheDocument();
    });

    it('le pack retiré pendant la lecture ramène à l’écran d’indisponibilité', async () => {
      native.available = true;
      native.failure = 'language-missing';
      open();
      await screen.findByRole('button', { name: 'Importer une image' });
      upload(png());
      expect(await screen.findByRole('heading', { name: 'Reconnaissance du texte indisponible' })).toBeInTheDocument();
    });
  });

  describe('webcam', () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;

    afterEach(() => {
      vi.unstubAllGlobals();
      track.stop.mockClear();
    });

    it('aucun accès à la webcam sans action explicite ; accès refusé : message, l’import reste possible (D4)', async () => {
      const getUserMedia = vi.fn(() => Promise.reject(new DOMException('refusé', 'NotAllowedError')));
      vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
      open();
      await screen.findByRole('button', { name: 'Utiliser la webcam' });
      expect(getUserMedia).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Utiliser la webcam' }));
      expect(await screen.findByText('L’accès à la webcam est refusé. Importez plutôt une image.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Importer une image' })).toBeEnabled();
    });

    it('aperçu avec « Prendre la photo » ; « Arrêter la webcam » coupe la caméra', async () => {
      const getUserMedia = vi.fn(() => Promise.resolve(stream));
      vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
      open();
      fireEvent.click(await screen.findByRole('button', { name: 'Utiliser la webcam' }));
      expect(await screen.findByLabelText('Aperçu de la webcam')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Prendre la photo' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Arrêter la webcam' }));
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(await screen.findByRole('button', { name: 'Importer une image' })).toBeInTheDocument();
    });

    it('fermer l’écran coupe la caméra (voyant éteint)', async () => {
      const getUserMedia = vi.fn(() => Promise.resolve(stream));
      vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
      const view = open();
      fireEvent.click(await screen.findByRole('button', { name: 'Utiliser la webcam' }));
      await screen.findByLabelText('Aperçu de la webcam');
      view.unmount();
      expect(track.stop).toHaveBeenCalled();
    });

    it('pas de webcam : message', async () => {
      vi.stubGlobal('navigator', { ...navigator, mediaDevices: undefined });
      open();
      fireEvent.click(await screen.findByRole('button', { name: 'Utiliser la webcam' }));
      expect(await screen.findByText('Aucune webcam n’a été trouvée. Importez plutôt une image.')).toBeInTheDocument();
    });
  });
});

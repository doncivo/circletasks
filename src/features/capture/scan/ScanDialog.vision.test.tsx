import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OcrService } from '../../../platform/ocr';
import { createFakeOcr, type FakeOcr } from '../../../platform/ocr/testing';
import { setSpeechRecognizer } from '../../../platform/speech';
import { createFakeSpeech } from '../../../platform/speech/testing';
import { AppContainerProvider } from '../../app/AppContainerContext';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../../today/testKit';
import { ScanDialog } from './ScanDialog';

/** Scan de tâches avec Vision sur iPhone (CAP-IOS-01 critères 2, 4, 17 ; I-05 critère 10), avec de faux moteurs. */
describe('scan de tâches : Vision sur iPhone', () => {
  let h: TodayHarness;
  let vision: FakeOcr;
  let embedded: FakeOcr;

  const service = (): OcrService => ({ primary: vision, fallback: embedded, dispose: () => Promise.resolve() });
  const png = (): File => new File([new Uint8Array(1_000)], 'liste.png', { type: 'image/png' });
  const open = () =>
    render(
      <AppContainerProvider container={h.container}>
        <ScanDialog onClose={() => undefined} service={service()} />
      </AppContainerProvider>,
    );
  const upload = (): void => {
    fireEvent.change(screen.getByLabelText('Choisir une image'), { target: { files: [png()] } });
  };

  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('b105', '2026-09-23T08:00:00.000Z');
    vision = createFakeOcr({
      id: 'vision',
      lines: [
        { text: '- plombier', confidence: 95 },
        { text: '- garage ?', confidence: 40 },
        { text: '- cantine', confidence: 80 },
      ],
    });
    embedded = createFakeOcr({ id: 'tesseract', lines: [{ text: 'Lu par le repli', confidence: 90 }] });
  });
  afterEach(async () => {
    cleanup();
    setSpeechRecognizer(null);
    await teardownToday(h);
  });

  it('critère 2 : confiances 95 / 40 / 80 → la ligne à 40 est décochée et signalée « Lecture incertaine »', async () => {
    open();
    await screen.findByRole('button', { name: 'Prendre ou choisir une photo' });
    upload();
    await screen.findByRole('heading', { name: 'Relecture' });
    const checks = screen.getAllByRole('button', { name: /Créer cette tâche|Ne pas créer cette tâche/ });
    expect(checks.map((c) => c.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'true']);
    const row = screen.getByRole('textbox', { name: 'Tâche 2' }).closest('li') as HTMLElement;
    expect(within(row).getByText('Lecture incertaine, à vérifier')).toBeInTheDocument();
    expect(vision.received).toHaveLength(1);
    expect(embedded.received).toHaveLength(0);
  });

  it('critère 4 : lecture refusée = erreur persistante avec son code, « Réessayer » et « Lire avec le moteur intégré », aucun repli silencieux', async () => {
    vision.failure = 'failed';
    open();
    await screen.findByRole('button', { name: 'Prendre ou choisir une photo' });
    upload();
    expect(await screen.findByRole('heading', { name: 'La lecture n’a pas abouti' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Code : ocr-engine');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(embedded.received).toHaveLength(0);
    // « Réessayer » : même image, même moteur.
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    await screen.findByRole('heading', { name: 'La lecture n’a pas abouti' });
    expect(vision.received).toHaveLength(2);
    // « Lire avec le moteur intégré » : le repli lit la même image, jusqu’à la relecture.
    fireEvent.click(screen.getByRole('button', { name: 'Lire avec le moteur intégré' }));
    await screen.findByRole('heading', { name: 'Relecture' });
    expect(embedded.received).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'Tâche 1' })).toHaveValue('Lu par le repli');
  });

  it('critère 17 : plugin absent = indisponible AVEC son code, repli jamais masqué ni automatique', async () => {
    vision.available = false;
    vision.reason = 'plugin-unavailable';
    open();
    expect(await screen.findByRole('heading', { name: 'Le moteur de lecture de l’iPhone est indisponible' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Code : vision-plugin-unavailable');
    expect(embedded.received).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Lire avec le moteur intégré' }));
    await screen.findByRole('button', { name: 'Prendre ou choisir une photo' });
    upload();
    await screen.findByRole('heading', { name: 'Relecture' });
    expect(embedded.received).toHaveLength(1);
    expect(vision.received).toHaveLength(0);
  });

  it('français absent de Vision : même écran, code vision-language-missing ; « Vérifier de nouveau » relit l’état', async () => {
    vision.available = false;
    vision.reason = 'language-missing';
    open();
    await screen.findByRole('heading', { name: 'Le moteur de lecture de l’iPhone est indisponible' });
    expect(screen.getByRole('alert')).toHaveTextContent('vision-language-missing');
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier de nouveau' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('reste indisponible'));
    vision.available = true;
    fireEvent.click(screen.getByRole('button', { name: 'Vérifier de nouveau' }));
    await screen.findByRole('button', { name: 'Prendre ou choisir une photo' });
  });

  it('I-05 critère 10 : indication de la caméra et « Ouvrir les réglages » (même appel natif que la dictée)', async () => {
    const speech = createFakeSpeech();
    setSpeechRecognizer(speech);
    open();
    await screen.findByRole('button', { name: 'Prendre ou choisir une photo' });
    expect(screen.getByText(/Pour photographier une liste, autorisez la caméra/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir les réglages' }));
    await waitFor(() => expect(speech.calls).toContain('openSettings'));
    expect(speech.calls).not.toContain('requestPermissions');
  });

  it('I-05 critère 10 : échec d’ouverture = message avec code ; sans le port (PC, navigateur) l’indication n’est pas affichée', async () => {
    setSpeechRecognizer(createFakeSpeech({ settingsFail: true }));
    open();
    await screen.findByRole('button', { name: 'Prendre ou choisir une photo' });
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir les réglages' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Code : settings-open-failed');
    cleanup();
    setSpeechRecognizer(null);
    open();
    await screen.findByRole('button', { name: 'Prendre ou choisir une photo' });
    expect(screen.queryByText(/Pour photographier une liste/)).toBeNull();
  });

  it('PC : aucune indication de caméra même avec le port', async () => {
    mockViewport(1440);
    setSpeechRecognizer(createFakeSpeech());
    open();
    await screen.findByRole('button', { name: 'Importer une image' });
    expect(screen.queryByText(/Pour photographier une liste/)).toBeNull();
  });
});

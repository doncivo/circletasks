import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../../domain/model';
import { addDays } from '../../domain/localDate';
import { setSpeechRecognizer } from '../../platform/speech';
import { createFakeSpeech, type FakeSpeech } from '../../platform/speech/testing';
import { currentExcursion, configureExcursions } from '../security/excursion';
import { resetAppLockStore, useAppLockStore } from '../security/appLockStore';
import { mockViewport, renderToday, setupToday, teardownToday, type TodayHarness } from '../today/testKit';

/** Autorisations de la dictée sur iPhone (I-05 critères 1 à 5, 12 ; CAP-IOS-01 critères 7 à 9 et 12), avec le faux de CAP-IOS-01. */
describe('dictée sur iPhone : autorisations et plugin (I-05, CAP-IOS-01)', () => {
  let h: TodayHarness;

  beforeEach(async () => {
    h = await setupToday('b103');
    mockViewport(440);
    configureExcursions();
  });
  afterEach(async () => {
    setSpeechRecognizer(null);
    resetAppLockStore();
    await teardownToday(h);
  });

  const field = (): HTMLInputElement => screen.getByLabelText('Nouvelle tâche');
  const tasks = async (): Promise<Task[]> => [
    ...(await h.container.data.repos.tasks.listForDay(h.today, 'all')),
    ...(await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all')),
  ];
  const setup = async (speech: FakeSpeech) => {
    setSpeechRecognizer(speech);
    renderToday(h.container);
    return screen.findByRole('button', { name: 'Dicter' });
  };
  const visibility = (state: 'visible' | 'hidden'): void => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };
  afterEach(() => visibility('visible'));

  it('critère 1 : aucune demande avant le geste ; premier appui = explication AVANT toute fenêtre d’iOS', async () => {
    const speech = createFakeSpeech({ state: { microphone: 'prompt', speechRecognition: 'prompt' } });
    const mic = await setup(speech);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(speech.calls).not.toContain('requestPermissions');
    expect(speech.calls).not.toContain('permissions');
    fireEvent.click(mic);
    const sheet = await screen.findByRole('dialog', { name: 'Dicter une tâche' });
    expect(within(sheet).getByText(/Rien n’est enregistré ni envoyé/)).toBeInTheDocument();
    expect(within(sheet).getByText(/le micro, puis la reconnaissance vocale/)).toBeInTheDocument();
    expect(speech.calls).not.toContain('requestPermissions');
    expect(speech.listens).toBe(0);
  });

  it('critère 1 : « Continuer » demande les autorisations (excursion « permission »), puis la dictée démarre', async () => {
    const speech = createFakeSpeech({ state: { microphone: 'prompt', speechRecognition: 'prompt' }, transcript: 'Appeler le plombier demain 9 h' });
    const original = speech.requestPermissions as () => Promise<unknown>;
    let kind: string | undefined;
    speech.requestPermissions = () => {
      kind = currentExcursion()?.kind;
      return original() as ReturnType<NonNullable<FakeSpeech['requestPermissions']>>;
    };
    fireEvent.click(await setup(speech));
    fireEvent.click(await screen.findByRole('button', { name: 'Continuer' }));
    await waitFor(() => expect(field()).toHaveValue('Appeler le plombier demain 9 h'));
    expect(kind).toBe('permission');
    expect(speech.calls.filter((c) => c === 'requestPermissions')).toHaveLength(1);
    expect(speech.listens).toBe(1);
    expect(await tasks()).toEqual([]);
  });

  it('critère 2 : « Pas maintenant » ne demande rien ; l’explication revient à l’appui suivant', async () => {
    const speech = createFakeSpeech({ state: { microphone: 'prompt', speechRecognition: 'prompt' } });
    const mic = await setup(speech);
    fireEvent.click(mic);
    fireEvent.click(await screen.findByRole('button', { name: 'Pas maintenant' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dicter une tâche' })).toBeNull());
    expect(speech.calls).not.toContain('requestPermissions');
    expect(screen.getByRole('button', { name: 'Dicter' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Dicter' }));
    expect(await screen.findByRole('dialog', { name: 'Dicter une tâche' })).toBeInTheDocument();
  });

  it('critère 3 : micro refusé = message persistant nommé avec « Ouvrir les réglages » ; l’appui rouvre le message sans redemander', async () => {
    const speech = createFakeSpeech({ state: { microphone: 'denied', speechRecognition: 'prompt' } });
    fireEvent.click(await setup(speech));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Le micro est refusé');
    expect(within(alert).getByRole('button', { name: 'Ouvrir les réglages' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dicter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Le micro est refusé');
    expect(speech.calls).not.toContain('requestPermissions');
    expect(speech.listens).toBe(0);
  });

  it('critère 3 : reconnaissance vocale refusée ou restreinte : message nommé', async () => {
    const denied = createFakeSpeech({ state: { speechRecognition: 'denied' } });
    fireEvent.click(await setup(denied));
    expect(await screen.findByRole('alert')).toHaveTextContent('La reconnaissance vocale est refusée');
  });

  it('critère 4 : « Ouvrir les réglages » passe par l’excursion « system-settings » ; au retour, autorisation rendue = message disparu', async () => {
    const speech = createFakeSpeech({ state: { microphone: 'denied' }, transcript: 'demain 9 h' });
    let kind: string | undefined;
    const open = speech.openSettings as () => Promise<void>;
    speech.openSettings = () => {
      kind = currentExcursion()?.kind;
      return open();
    };
    fireEvent.click(await setup(speech));
    fireEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Ouvrir les réglages' }));
    await waitFor(() => expect(speech.calls).toContain('openSettings'));
    expect(kind).toBe('system-settings');
    // Toujours refusé au retour : message conservé.
    visibility('hidden');
    visibility('visible');
    await waitFor(() => expect(speech.calls.filter((c) => c === 'permissions').length).toBeGreaterThan(1));
    expect(screen.getByRole('alert')).toHaveTextContent('Le micro est refusé');
    // Autorisation rendue dans Réglages : message disparu, dictée possible au prochain appui.
    speech.state = { microphone: 'granted', speechRecognition: 'granted' };
    visibility('hidden');
    visibility('visible');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Dicter' }));
    await waitFor(() => expect(field()).toHaveValue('demain 9 h'));
  });

  it('critère 5 : micro accordé puis reconnaissance refusée : pas d’écoute, message nommé, micro non redemandé', async () => {
    const speech = createFakeSpeech({ state: { microphone: 'prompt', speechRecognition: 'prompt' }, afterRequest: { microphone: 'granted', speechRecognition: 'denied' } });
    fireEvent.click(await setup(speech));
    fireEvent.click(await screen.findByRole('button', { name: 'Continuer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La reconnaissance vocale est refusée');
    expect(speech.listens).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Dicter' }));
    await screen.findByRole('alert');
    expect(speech.calls.filter((c) => c === 'requestPermissions')).toHaveLength(1);
  });

  it('critère 12 : état illisible et lecture en échec dits avec leur code ; échec d’ouverture des Réglages dit avec son code', async () => {
    const unknown = createFakeSpeech({ state: { microphone: 'unknown' } });
    fireEvent.click(await setup(unknown));
    expect(await screen.findByRole('alert')).toHaveTextContent('Code : permission-unknown-microphone');
    expect(unknown.listens).toBe(0);
  });

  it('critère 12 : lecture de l’état en échec = message avec code', async () => {
    const failing = createFakeSpeech({ permissionsFail: true });
    fireEvent.click(await setup(failing));
    expect(await screen.findByRole('alert')).toHaveTextContent('Code : speech-status-failed');
  });

  it('critère 12 : ouverture des Réglages en échec = message avec code, jamais un bouton muet', async () => {
    const speech = createFakeSpeech({ state: { microphone: 'denied' }, settingsFail: true });
    fireEvent.click(await setup(speech));
    fireEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Ouvrir les réglages' }));
    expect(await screen.findByText(/Les réglages n’ont pas pu s’ouvrir.*Code : settings-open-failed/)).toBeInTheDocument();
  });

  it('CAP-IOS-01 critère 12 : sans modèle hors ligne, dictée désactivée, message persistant, AUCUNE tentative d’écoute', async () => {
    const speech = createFakeSpeech({ onDevice: false });
    fireEvent.click(await setup(speech));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('La dictée hors ligne en français n’est pas disponible sur cet iPhone');
    expect(alert).toHaveTextContent('Réglages › Général › Clavier › Dictée');
    expect(alert).toHaveTextContent('Le micro du clavier reste utilisable');
    expect(speech.listens).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Dicter' }));
    await screen.findByRole('alert');
    expect(speech.listens).toBe(0);
  });

  it('CAP-IOS-01 critère 12 : rejet on-device-unavailable du plugin = même message persistant', async () => {
    const speech = createFakeSpeech({ failure: 'on-device-unavailable', failureCode: 'speech-on-device-unavailable' });
    fireEvent.click(await setup(speech));
    expect(await screen.findByRole('alert')).toHaveTextContent('La dictée hors ligne en français');
  });

  it('refus signalé par le plugin au moment de l’écoute : message nommé avec « Ouvrir les réglages »', async () => {
    const speech = createFakeSpeech({ failure: 'permission-denied', deniedPermission: 'microphone', failureCode: 'speech-microphone-denied' });
    fireEvent.click(await setup(speech));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Le micro est refusé');
    expect(within(alert).getByRole('button', { name: 'Ouvrir les réglages' })).toBeInTheDocument();
  });

  it('autres échecs : message avec code (busy, unavailable)', async () => {
    const busy = createFakeSpeech({ failure: 'busy', failureCode: 'speech-busy' });
    fireEvent.click(await setup(busy));
    expect(await screen.findByRole('alert')).toHaveTextContent('Une dictée est déjà en cours. Code : speech-busy');
  });

  it('CAP-IOS-01 critère 9 : app masquée pendant l’écoute = arrêt, texte déjà reconnu conservé dans le champ', async () => {
    const speech = createFakeSpeech({ waitForStop: true, transcript: 'Payer la cantine', stoppedBy: 'background' });
    fireEvent.click(await setup(speech));
    await screen.findByRole('dialog', { name: 'Je vous écoute' });
    visibility('hidden');
    await waitFor(() => expect(field()).toHaveValue('Payer la cantine'));
    expect(screen.queryByRole('dialog', { name: 'Je vous écoute' })).toBeNull();
    expect(await tasks()).toEqual([]);
  });

  it('CAP-IOS-01 critère 9 : verrou fermé pendant l’écoute = arrêt', async () => {
    const speech = createFakeSpeech({ waitForStop: true, transcript: 'Appeler Paul', stoppedBy: 'user' });
    fireEvent.click(await setup(speech));
    await screen.findByRole('dialog', { name: 'Je vous écoute' });
    act(() => {
      useAppLockStore.setState({ phase: 'locked' });
    });
    await waitFor(() => expect(field()).toHaveValue('Appeler Paul'));
  });

  it('messages d’information : rien entendu, limite de 60 s', async () => {
    const silent = createFakeSpeech({ transcript: '' });
    fireEvent.click(await setup(silent));
    expect(await screen.findByText('Rien n’a été entendu. Réessayez.')).toHaveAttribute('role', 'status');
  });

  it('limite de 60 s : texte rendu et message', async () => {
    const limit = createFakeSpeech({ transcript: 'Réunion lundi', stoppedBy: 'time-limit' });
    fireEvent.click(await setup(limit));
    await waitFor(() => expect(field()).toHaveValue('Réunion lundi'));
    expect(await screen.findByText('Dictée arrêtée après 60 s.')).toHaveAttribute('role', 'status');
  });
});

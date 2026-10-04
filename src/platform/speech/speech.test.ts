import { afterEach, describe, expect, it } from 'vitest';
import { getSpeechRecognizer, setSpeechRecognizer, SpeechError, unavailableSpeech } from './index';
import { createFakeSpeech } from './testing';

/** Contrat de la dictée (Q-03 critère 5) : indisponible à l'ordre 3, faux pour les tests, Swift Speech à l'ordre 5. */
describe('SpeechRecognizer', () => {
  afterEach(() => setSpeechRecognizer(null));

  it('à l’ordre 3 l’implémentation est indisponible : le bouton micro de l’app n’apparaît jamais', async () => {
    expect(getSpeechRecognizer()).toBe(unavailableSpeech);
    expect(await getSpeechRecognizer().isAvailable()).toBe(false);
    await expect(getSpeechRecognizer().listen({ locale: 'fr-FR' })).rejects.toMatchObject({ name: 'SpeechError', reason: 'unavailable' });
  });

  it('le faux rend le texte prédéfini en français', async () => {
    const fake = createFakeSpeech({ transcript: 'Appeler le plombier demain 9 h' });
    setSpeechRecognizer(fake);
    expect(await getSpeechRecognizer().isAvailable()).toBe(true);
    expect(await getSpeechRecognizer().listen({ locale: 'fr-FR' })).toBe('Appeler le plombier demain 9 h');
    expect(fake.listens).toBe(1);
  });

  it('refus de permission : SpeechError « permission-denied »', async () => {
    setSpeechRecognizer(createFakeSpeech({ failure: 'permission-denied' }));
    const error = await getSpeechRecognizer().listen({ locale: 'fr-FR' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpeechError);
    expect((error as SpeechError).reason).toBe('permission-denied');
  });

  it('« Terminer » : le signal d’arrêt rend le texte reconnu jusque-là', async () => {
    const fake = createFakeSpeech({ transcript: 'bonjour', waitForStop: true });
    const stop = new AbortController();
    const pending = fake.listen({ locale: 'fr-FR', stopSignal: stop.signal });
    let done = false;
    void pending.then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    stop.abort();
    expect(await pending).toBe('bonjour');
  });

  it('un signal déjà déclenché rend le texte aussitôt', async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await createFakeSpeech({ transcript: 'déjà', waitForStop: true }).listen({ locale: 'fr-FR', stopSignal: stop.signal })).toBe('déjà');
  });

  it('remplacer le reconnaisseur puis le retirer rétablit « indisponible »', () => {
    const fake = createFakeSpeech();
    setSpeechRecognizer(fake);
    expect(getSpeechRecognizer()).toBe(fake);
    setSpeechRecognizer(null);
    expect(getSpeechRecognizer()).toBe(unavailableSpeech);
  });

  it('aucun enregistrement n’est conservé : le contrat ne rend que du texte', async () => {
    const result = await createFakeSpeech().listen({ locale: 'fr-FR' });
    expect(typeof result).toBe('string');
  });
});

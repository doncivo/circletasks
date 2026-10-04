import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeFocusEndScheduler, createFakeSoundPlayer, createHtmlAudioPlayer, createMemoryFocusWindow, createNoopFocusEndScheduler, openFocusWindowClient, openFocusWindowPlatform } from './index';

afterEach(() => vi.unstubAllGlobals());

describe('FocusEndScheduler (F-04 critère 8)', () => {
  it('l’implémentation vide ne fait rien et ne rejette jamais (envoi réel : ordre 5)', async () => {
    const scheduler = createNoopFocusEndScheduler();
    await expect(scheduler.schedule('s1', new Date(), 'Titre')).resolves.toBeUndefined();
    await expect(scheduler.cancel('s1')).resolves.toBeUndefined();
  });

  it('le faux enregistre les appels et retient une notification par session ; schedule remplace, cancel retire', async () => {
    const scheduler = createFakeFocusEndScheduler();
    await scheduler.schedule('s1', new Date('2026-10-04T08:25:00.000Z'), 'A');
    await scheduler.schedule('s2', new Date('2026-10-04T09:00:00.000Z'), 'B');
    await scheduler.schedule('s1', new Date('2026-10-04T08:45:00.000Z'), 'A');
    expect(scheduler.pending().size).toBe(2);
    expect(scheduler.pending().get('s1')?.fireAt).toEqual(new Date('2026-10-04T08:45:00.000Z'));
    await scheduler.cancel('s1');
    await scheduler.cancel('inconnue');
    expect([...scheduler.pending().keys()]).toEqual(['s2']);
    expect(scheduler.calls.map((call) => call.type)).toEqual(['schedule', 'schedule', 'schedule', 'cancel', 'cancel']);
  });
});

describe('SoundPlayer', () => {
  it('le lecteur Audio joue le fichier embarqué depuis le début, et ignore un refus de lecture', async () => {
    const play = vi.fn(() => Promise.resolve());
    const instances: { src: string; currentTime: number; play: typeof play }[] = [];
    vi.stubGlobal(
      'Audio',
      class {
        currentTime = 3;
        play = play;
        constructor(readonly src: string) {
          instances.push(this);
        }
      },
    );
    const player = createHtmlAudioPlayer('/focus-end.wav');
    await player.play();
    await player.play();
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ src: '/focus-end.wav', currentTime: 0 });
    expect(play).toHaveBeenCalledTimes(2);
    play.mockRejectedValueOnce(new Error('NotAllowedError'));
    await expect(player.play()).resolves.toBeUndefined();
  });

  it('le faux compte les lectures', async () => {
    const player = createFakeSoundPlayer();
    await player.play();
    expect(player.plays()).toBe(1);
  });
});

describe('Mini-fenêtre : détection de la plateforme et faux', () => {
  it('hors Tauri (navigateur, tests, iPhone) : aucune mini-fenêtre système ni client', async () => {
    expect(await openFocusWindowPlatform('web', 'windows')).toBeNull();
    expect(await openFocusWindowPlatform('tauri', 'ios')).toBeNull();
    expect(await openFocusWindowClient('web')).toBeNull();
  });

  it('le faux relie fenêtre principale et mini-fenêtre : l’état publié est renvoyé à l’ouverture et les ordres remontent', async () => {
    const memory = createMemoryFocusWindow();
    const received: unknown[] = [];
    await memory.client.onState((state) => received.push(state.phase));
    const actions: string[] = [];
    await memory.platform.onAction((action) => actions.push(action.type));
    await memory.platform.open({ x: 1, y: 2 });
    expect(memory.openedAt).toEqual([{ x: 1, y: 2 }]);
    await memory.client.send({ type: 'ready' });
    memory.move({ x: 5, y: 6 });
    expect(actions).toEqual(['ready', 'moved']);
    await memory.platform.close();
    expect(memory.isOpen()).toBe(false);
    await memory.platform.bringToFront();
    expect(memory.bringToFrontCount()).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createMainBridge, createMemoryBus, createWindowBridge } from './index';
import type { CaptureContextSnapshot } from './types';

const CONTEXT: CaptureContextSnapshot = {
  spaces: [{ id: 's1' as never, name: 'Pro', sortOrder: 1 }],
  projects: [],
  spaceFilter: 'all',
  firstWeekday: 'monday',
};

function pair(timeoutMs?: number) {
  const bus = createMemoryBus();
  return { bus, main: createMainBridge(bus.main), window: createWindowBridge(bus.window, timeoutMs) };
}

describe('pont de la capture rapide (Q-01)', () => {
  it('le texte part vers la fenêtre principale et la réponse revient à la mini-fenêtre', async () => {
    const { main, window } = pair();
    const received = vi.fn<(text: string, ignored: readonly string[]) => void>();
    await main.onSubmit(async (request) => {
      received(request.text, request.ignored);
      return { ok: true, title: 'Appeler le notaire' };
    });
    const reply = await window.submit({ text: 'Appeler le notaire demain 10h #pro', ignored: ['date:demain 10h'] });
    expect(reply).toEqual({ ok: true, title: 'Appeler le notaire' });
    expect(received).toHaveBeenCalledWith('Appeler le notaire demain 10h #pro', ['date:demain 10h']);
  });

  it('un refus de la fenêtre principale revient tel quel (titre vide, aucun espace)', async () => {
    const { main, window } = pair();
    await main.onSubmit(async () => ({ ok: false, error: 'title-empty' }));
    expect(await window.submit({ text: '#pro', ignored: [] })).toEqual({ ok: false, error: 'title-empty' });
  });

  it('un gestionnaire qui rejette donne « failed » sans bloquer la mini-fenêtre', async () => {
    const { main, window } = pair();
    await main.onSubmit(() => Promise.reject(new Error('base fermée')));
    expect(await window.submit({ text: 'x', ignored: [] })).toEqual({ ok: false, error: 'failed' });
  });

  it('sans fenêtre principale à l’écoute, l’attente est bornée : échec « failed »', async () => {
    vi.useFakeTimers();
    try {
      const { window } = pair(8_000);
      const pending = window.submit({ text: 'Appeler', ignored: [] });
      await vi.advanceTimersByTimeAsync(8_001);
      expect(await pending).toEqual({ ok: false, error: 'failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('deux envois successifs ne se mélangent pas (identifiant de requête)', async () => {
    const { main, window } = pair();
    await main.onSubmit(async (request) => ({ ok: true, title: request.text.toUpperCase() }));
    const [a, b] = await Promise.all([window.submit({ text: 'un', ignored: [] }), window.submit({ text: 'deux', ignored: [] })]);
    expect(a).toEqual({ ok: true, title: 'UN' });
    expect(b).toEqual({ ok: true, title: 'DEUX' });
  });

  it('les messages mal formés sont ignorés', async () => {
    const { bus, main } = pair();
    const handler = vi.fn(async () => ({ ok: true as const, title: 't' }));
    await main.onSubmit(handler);
    await bus.window.emit('main', 'capture:submit', { text: 3 });
    await bus.window.emit('main', 'capture:submit', null);
    await bus.window.emit('main', 'capture:submit', { requestId: 'x', text: 'ok' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('le contexte (espaces, projets, filtre) est publié sur demande et à l’initiative de la fenêtre principale', async () => {
    const { main, window } = pair();
    const seen = vi.fn<(context: CaptureContextSnapshot) => void>();
    await window.onContext(seen);
    await main.onContextRequest(() => void main.publishContext(CONTEXT));
    await window.requestContext();
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith(CONTEXT));
    await main.publishContext({ ...CONTEXT, spaceFilter: 'all', firstWeekday: 'sunday' });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(2));
  });

  it('un contexte mal formé est ignoré', async () => {
    const { bus, window } = pair();
    const seen = vi.fn();
    await window.onContext(seen);
    await bus.main.emit('quick-capture', 'capture:context', { spaces: 'non' });
    await bus.main.emit('quick-capture', 'capture:context', null);
    expect(seen).not.toHaveBeenCalled();
  });

  it('cacher et agrandir passent par les commandes Rust', async () => {
    const { bus, window } = pair();
    await window.hide();
    await window.resize(300);
    expect(bus.invoked).toEqual(['hide_quick_capture', 'resize_quick_capture:{"height":300}']);
  });

  it('« montrée » et « perte de focus » arrivent à la mini-fenêtre', async () => {
    const { bus, window } = pair();
    const shown = vi.fn();
    const blurred = vi.fn();
    await window.onShown(shown);
    await window.onBlurred(blurred);
    await bus.main.emit('quick-capture', 'capture://shown', null);
    await bus.main.emit('quick-capture', 'capture://blurred', null);
    expect(shown).toHaveBeenCalledTimes(1);
    expect(blurred).toHaveBeenCalledTimes(1);
  });

  it('se désabonner arrête la réception', async () => {
    const { bus, main } = pair();
    const handler = vi.fn(async () => ({ ok: true as const, title: 't' }));
    const stop = await main.onSubmit(handler);
    stop();
    await bus.window.emit('main', 'capture:submit', { requestId: 'x', text: 'ok', ignored: [] });
    expect(handler).not.toHaveBeenCalled();
  });
});

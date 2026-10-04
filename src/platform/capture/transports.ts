import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { SHOWN_EVENT } from './events';
import type { CaptureTransport, Unlisten } from './types';

/** Transport de l'app installée : événements Tauri ciblés par libellé de fenêtre, commandes Rust pour cacher / redimensionner. */
export function createTauriTransport(): CaptureTransport {
  return {
    emit: (target, event, payload) => emitTo(target, event, payload),
    listen: (event, handler) => listen(event, (message) => handler(message.payload)),
    invoke: async (command, args) => {
      await invoke(command, args);
    },
  };
}

interface ChannelMessage {
  readonly target: string;
  readonly event: string;
  readonly payload: unknown;
}

/** Nom du canal du navigateur de développement (partagé par les onglets de même origine). */
export const CHANNEL_NAME = 'ct-quick-capture';

/**
 * Transport du navigateur de développement et de Playwright : un `BroadcastChannel` relie l'onglet principal (`self: 'main'`) et
 * l'onglet `capture.html` (`self: 'quick-capture'`). « Cacher » pose `data-window-state="hidden"` sur la page ; l'événement
 * `capture:shown` du navigateur simule la réouverture par le raccourci. Aucun effet dans l'app installée.
 */
export function createChannelTransport(self: string, doc: Document = document): CaptureTransport {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const listeners = new Set<(message: ChannelMessage) => void>();
  channel.onmessage = (message: MessageEvent<ChannelMessage>) => {
    for (const listener of [...listeners]) listener(message.data);
  };
  return {
    emit: (target, event, payload) => {
      channel.postMessage({ target, event, payload } satisfies ChannelMessage);
      return Promise.resolve();
    },
    listen: (event, handler) => {
      const onChannel = (message: ChannelMessage): void => {
        if (message.event === event && message.target === self) handler(message.payload);
      };
      listeners.add(onChannel);
      const stops: Unlisten[] = [() => listeners.delete(onChannel)];
      if (event === SHOWN_EVENT) {
        const onShown = (): void => {
          doc.documentElement.dataset['windowState'] = 'visible';
          handler(null);
        };
        globalThis.addEventListener('ct-capture-shown', onShown);
        stops.push(() => globalThis.removeEventListener('ct-capture-shown', onShown));
      }
      return Promise.resolve(() => stops.forEach((stop) => stop()));
    },
    invoke: (command) => {
      if (command === 'hide_quick_capture') doc.documentElement.dataset['windowState'] = 'hidden';
      return Promise.resolve();
    },
  };
}

/** Sans canal ni Tauri (tests) : un transport relié à rien. */
export function createMemoryBus(): { readonly main: CaptureTransport; readonly window: CaptureTransport; readonly invoked: string[] } {
  const handlers = new Map<string, Set<{ readonly side: string; readonly handler: (payload: unknown) => void }>>();
  const invoked: string[] = [];
  const side = (self: string): CaptureTransport => ({
    emit: async (target, event, payload) => {
      await Promise.resolve();
      for (const entry of [...(handlers.get(event) ?? [])]) if (entry.side === target) entry.handler(structuredClone(payload));
    },
    listen: (event, handler) => {
      const entry = { side: self, handler };
      const set = handlers.get(event) ?? new Set();
      set.add(entry);
      handlers.set(event, set);
      return Promise.resolve(() => set.delete(entry));
    },
    invoke: (command, args) => {
      invoked.push(args ? `${command}:${JSON.stringify(args)}` : command);
      return Promise.resolve();
    },
  });
  return { main: side('main'), window: side('quick-capture'), invoked };
}

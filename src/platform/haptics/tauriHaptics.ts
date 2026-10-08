import { invoke } from '@tauri-apps/api/core';
import type { Haptics, HapticsCommand } from './types';

/**
 * Adaptateur iOS du plugin local `haptics` (crate `tauri-plugin-ct-haptics`, `src-tauri/plugins/haptics`, ADR 0013 §1.1) : SEUL fichier
 * qui nomme `plugin:haptics|` (test de cohérence). Le Swift déclenche le générateur sur le fil principal. Appel sans attente : un rejet
 * est journalisé une fois par commande et par processus, jamais affiché (cosmétique).
 */

export type PluginInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const PLUGIN = 'plugin:haptics|';

export function createTauriHaptics(log: (code: string) => void, call: PluginInvoke = (command, args) => invoke(command, args)): Haptics {
  const failed = new Set<HapticsCommand>();
  const send = (command: HapticsCommand, args?: Record<string, unknown>): void => {
    let pending: Promise<unknown>;
    try {
      pending = call(`${PLUGIN}${command}`, args);
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.catch(() => {
      if (failed.has(command)) return;
      failed.add(command);
      log(`haptics-failed:${command}`);
    });
  };
  return {
    impact: (style) => send('impact_feedback', { style }),
    notification: (kind) => send('notification_feedback', { type: kind }),
    selection: () => send('selection_feedback'),
  };
}

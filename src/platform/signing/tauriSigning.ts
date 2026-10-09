import { invoke } from '@tauri-apps/api/core';
import type { IsoDateTime } from '../../domain/types';
import type { SigningRead, SigningSource } from './types';

/**
 * Adaptateur iOS de la commande Rust `app_signing_info` (ADR 0013 §3.1) : SEUL fichier de `src` qui nomme `app_signing_info` (test de
 * cohérence). Rendu : deux dates UTC ; rejet : un code (`profile-missing`, `profile-unreadable`), tout autre rejet : `unavailable`
 * (commande absente ou refusée), réponse mal formée : `profile-unreadable`. Ne rejette jamais.
 */

export type CommandInvoke = (command: string) => Promise<unknown>;

const isIso = (value: unknown): value is IsoDateTime => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && !Number.isNaN(Date.parse(value));

export function createTauriSigningSource(call: CommandInvoke = (command) => invoke(command)): SigningSource {
  return {
    supported: true,
    async read(): Promise<SigningRead> {
      try {
        const answer = await call('app_signing_info');
        const record = typeof answer === 'object' && answer !== null ? (answer as { expiresAt?: unknown; issuedAt?: unknown }) : null;
        if (record === null || !isIso(record.expiresAt)) return { ok: false, code: 'profile-unreadable' };
        const issued = record.issuedAt;
        if (issued !== null && issued !== undefined && !isIso(issued)) return { ok: false, code: 'profile-unreadable' };
        return { ok: true, expiresAt: record.expiresAt, issuedAt: isIso(issued) ? issued : null };
      } catch (error) {
        const code = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
        if (code === 'profile-missing' || code === 'profile-unreadable') return { ok: false, code };
        return { ok: false, code: 'unavailable' };
      }
    },
  };
}

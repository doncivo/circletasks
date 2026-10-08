import { EMPTY_LEDGER, type LedgerRead, type NotificationLedgerV1 } from '../../domain/notificationLedger';

/**
 * Port du registre local (ADR 0012 avenant N1.2) : la feature le fournit (réglage LOCAL `notifications.ledger` via
 * `SettingsRepository`), l'adaptateur réel et celui de la fin de Focus le partagent par un `LedgerStore`.
 */
export interface NotificationLedger {
  /** Ne rejette jamais : une lecture impossible vaut `unreadable`. */
  load(): Promise<LedgerRead>;
  /** Rejette si l'écriture est impossible (l'adaptateur en fait `ledger-failed`). */
  save(ledger: NotificationLedgerV1): Promise<void>;
}

/** Accès sérialisé au registre : les lectures-modifications-écritures du plan et de la fin de Focus ne s'écrasent jamais. */
export interface LedgerStore {
  read(): Promise<LedgerRead>;
  /** Lit (registre absent ou illisible = vide), applique `change`, écrit. Rejette si l'écriture échoue ; la file continue. */
  update(change: (current: NotificationLedgerV1) => NotificationLedgerV1): Promise<void>;
}

export function createLedgerStore(port: NotificationLedger): LedgerStore {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    read: () => port.load().catch((): LedgerRead => ({ state: 'unreadable' })),
    update: (change) => {
      const run = chain.then(async () => {
        const read = await port.load().catch((): LedgerRead => ({ state: 'unreadable' }));
        await port.save(change(read.state === 'valid' ? read.ledger : EMPTY_LEDGER));
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

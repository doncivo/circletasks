import type { Migration } from '../migrator';

/**
 * Identifiant Apple d'un compte iCloud (ADR 0011, section 8, audit M6 et second audit point 9 ; Y-02 critère 10).
 *
 * Jusqu'ici `calendar_account.label` portait l'identifiant Apple, utilisé comme nom d'utilisateur de l'authentification Basic : publié,
 * un `label` modifié ailleurs aurait changé l'identifiant envoyé à Apple. La nouvelle colonne **locale** `username` (jamais publiée,
 * absente du catalogue et des déclencheurs) le reçoit ; `label` est vidé pour ces comptes et ne sert plus qu'à l'affichage
 * (`accountDisplayName` : `username`, sinon « Compte iCloud »). Exécutée sous `sync_guard` : la réécriture de `label` n'entre pas dans
 * la file d'envoi. Le coffre n'est pas touché.
 */
export const migration0017CalendarAccountUsername: Migration = {
  version: 17,
  name: 'calendar_account_username',
  statements: [
    'INSERT OR IGNORE INTO sync_guard (id) VALUES (1)',
    "ALTER TABLE calendar_account ADD COLUMN username TEXT NOT NULL DEFAULT ''",
    "UPDATE calendar_account SET username = label WHERE provider = 'icloud'",
    "UPDATE calendar_account SET label = '' WHERE provider = 'icloud'",
    'DELETE FROM sync_guard',
  ],
};

/**
 * Simulateur du magasin EventKit (K-05 à K-07, ADR 0008 §10.4) : listes, rappels, modification, achèvement, suppression, événement
 * `changed`, accès, pannes injectées, journal des appels et des écritures. Le code est celui du faux de l'app
 * (`src/platform/reminders/fakeReminders.ts`, sans dépendance à Node : il tourne aussi dans la page des tests de bout en bout) ; ce fichier
 * le range avec les autres simulateurs du banc.
 */
export { createFakeReminders as createRemindersSim, type FakeReminders as RemindersSim, type FakeRemindersWrite, type NewFakeReminder } from '../../src/platform/reminders/fakeReminders';

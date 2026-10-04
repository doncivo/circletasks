/**
 * Fixtures ICS du simulateur CalDAV (K-02 critère 5) : tels que renvoyés par iCloud après `expand` (une instance par objet, avec
 * RECURRENCE-ID pour les séries ; EXDATE déjà appliqué par le serveur). `startUtc` / `endUtc` servent seulement au filtre de plage.
 */

export interface CaldavSimObject {
  readonly href: string;
  readonly etag: string;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly ics: string;
}

export interface CaldavSimCalendar {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  /** VEVENT : agenda d'événements ; VTODO : liste Rappels, à ignorer (K-02 critère 4, K-05). */
  readonly component: 'VEVENT' | 'VTODO';
  objects: readonly CaldavSimObject[];
}

const ics = (...lines: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CircleTasks//Simulateur//FR', ...lines, 'END:VCALENDAR', ''].join('\r\n');

const PARIS_TZ = ['BEGIN:VTIMEZONE', 'TZID:Europe/Paris', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];

export const CALDAV_FIXTURE_CALENDARS: CaldavSimCalendar[] = [
  {
    id: 'famille',
    name: 'Famille',
    color: '#B5483BFF',
    component: 'VEVENT',
    objects: [
      {
        // Heure avec TZID : 19:00 Paris (heure d'été) = 17:00 UTC.
        href: 'diner.ics',
        etag: 'e1',
        startUtc: '2026-09-24T17:00:00Z',
        endUtc: '2026-09-24T19:00:00Z',
        ics: ics(...PARIS_TZ, 'BEGIN:VEVENT', 'UID:diner-1', 'DTSTAMP:20260901T000000Z', 'DTSTART;TZID=Europe/Paris:20260924T190000', 'DTEND;TZID=Europe/Paris:20260924T210000', 'SUMMARY:Dîner chez Leïla', 'END:VEVENT'),
      },
      {
        // Heure flottante : interprétée dans le fuseau de l'appareil.
        href: 'flottant.ics',
        etag: 'e2',
        startUtc: '2026-09-26T00:00:00Z',
        endUtc: '2026-09-27T00:00:00Z',
        ics: ics('BEGIN:VEVENT', 'UID:flottant-1', 'DTSTAMP:20260901T000000Z', 'DTSTART:20260926T093000', 'DTEND:20260926T103000', 'SUMMARY:Marché', 'END:VEVENT'),
      },
      {
        // Journée entière sur trois jours, fin exclue (30 sept.).
        href: 'weekend.ics',
        etag: 'e3',
        startUtc: '2026-09-27T00:00:00Z',
        endUtc: '2026-09-30T00:00:00Z',
        ics: ics('BEGIN:VEVENT', 'UID:weekend-1', 'DTSTAMP:20260901T000000Z', 'DTSTART;VALUE=DATE:20260927', 'DTEND;VALUE=DATE:20260930', 'SUMMARY:Week-end à Tunis', 'END:VEVENT'),
      },
      {
        // Annulé : exclu.
        href: 'annule.ics',
        etag: 'e4',
        startUtc: '2026-09-28T08:00:00Z',
        endUtc: '2026-09-28T09:00:00Z',
        ics: ics('BEGIN:VEVENT', 'UID:annule-1', 'DTSTAMP:20260901T000000Z', 'DTSTART:20260928T080000Z', 'DTEND:20260928T090000Z', 'STATUS:CANCELLED', 'SUMMARY:Rendez-vous annulé', 'END:VEVENT'),
      },
      {
        // Série développée par le serveur : deux instances (la troisième, en EXDATE, n'est pas renvoyée).
        href: 'piscine.ics',
        etag: 'e5',
        startUtc: '2026-09-22T16:00:00Z',
        endUtc: '2026-09-29T17:00:00Z',
        ics: ics(
          'BEGIN:VEVENT', 'UID:piscine', 'DTSTAMP:20260901T000000Z', 'RECURRENCE-ID:20260922T160000Z', 'DTSTART:20260922T160000Z', 'DTEND:20260922T170000Z', 'SUMMARY:Piscine', 'END:VEVENT',
          'BEGIN:VEVENT', 'UID:piscine', 'DTSTAMP:20260901T000000Z', 'RECURRENCE-ID:20260929T160000Z', 'DTSTART:20260929T160000Z', 'DTEND:20260929T170000Z', 'SUMMARY:Piscine', 'END:VEVENT',
        ),
      },
      {
        // Sans titre : « (Sans titre) » à l'affichage (K-02 D3).
        href: 'sans-titre.ics',
        etag: 'e6',
        startUtc: '2026-10-01T12:00:00Z',
        endUtc: '2026-10-01T13:00:00Z',
        ics: ics('BEGIN:VEVENT', 'UID:sans-titre-1', 'DTSTAMP:20260901T000000Z', 'DTSTART:20261001T120000Z', 'DTEND:20261001T130000Z', 'END:VEVENT'),
      },
    ],
  },
  {
    id: 'rappels',
    name: 'Rappels',
    color: '#E0A33BFF',
    component: 'VTODO',
    objects: [],
  },
];

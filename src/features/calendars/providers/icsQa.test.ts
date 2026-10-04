import { describe, expect, it } from 'vitest';
import { eventsFromIcs } from './icsEvents';

/** QA du lot K : fuseaux (TZID) et récurrences externes aux limites (K-02 critère 5, K-03 critère 9). */
const RANGE = { fromMs: Date.parse('2026-01-01T00:00:00Z'), toMs: Date.parse('2028-01-01T00:00:00Z') };
const ics = (...lines: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const vevent = (...lines: string[]): string[] => ['BEGIN:VEVENT', 'DTSTAMP:20260901T000000Z', ...lines, 'END:VEVENT'];
const read = (text: string, tz = 'Europe/Paris') => eventsFromIcs('cal', text, RANGE, tz);

describe('K-02 c.5 fuseaux', () => {
  it('K-02 c.5 TZID inconnu et sans VTIMEZONE : repli sur le fuseau de l’appareil, sans exception', () => {
    const [event] = read(ics(...vevent('UID:z', 'DTSTART;TZID=Mars/Olympus:20260924T190000', 'DTEND;TZID=Mars/Olympus:20260924T200000', 'SUMMARY:Z')), 'Europe/Paris');
    expect(event).toMatchObject({ startUtc: '2026-09-24T17:00:00Z', endUtc: '2026-09-24T18:00:00Z' });
  });

  it('K-02 c.5 TZID lointain (Pacific/Auckland, UTC+12 avant le 27 sept.) : l’heure locale tombe la veille en UTC', () => {
    const [event] = read(ics(...vevent('UID:a', 'DTSTART;TZID=Pacific/Auckland:20260924T080000', 'DTEND;TZID=Pacific/Auckland:20260924T090000', 'SUMMARY:A')));
    expect(event).toMatchObject({ startUtc: '2026-09-23T20:00:00Z', endUtc: '2026-09-23T21:00:00Z' });
  });

  it('K-02 c.5 journée entière : même date civile quel que soit le fuseau de l’appareil', () => {
    const text = ics(...vevent('UID:d', 'DTSTART;VALUE=DATE:20260924', 'DTEND;VALUE=DATE:20260925', 'SUMMARY:Journée'));
    for (const tz of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC', 'Europe/Paris']) {
      expect(read(text, tz)[0]).toMatchObject({ startUtc: '2026-09-24', endUtc: '2026-09-25', allDay: true });
    }
  });

  it('K-02 c.5 heure inexistante (passage à l’heure d’été, 02:30 le 29 mars 2026 à Paris) : un instant valide, sans exception', () => {
    const [event] = read(ics(...vevent('UID:g', 'DTSTART;TZID=Europe/Paris:20260329T023000', 'DTEND;TZID=Europe/Paris:20260329T033000', 'SUMMARY:Trou')));
    expect(Number.isNaN(Date.parse(event?.startUtc ?? ''))).toBe(false);
    expect(['2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z']).toContain(event?.startUtc);
  });
});

describe('K-02 c.5 séries externes aux limites', () => {
  it('K-02 c.5 série de journées entières avec EXDATE;VALUE=DATE : la date exclue disparaît', () => {
    const text = ics(...vevent('UID:s', 'DTSTART;VALUE=DATE:20260901', 'DTEND;VALUE=DATE:20260902', 'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE;VALUE=DATE:20260902', 'SUMMARY:S'));
    expect(read(text).map((event) => event.startUtc)).toEqual(['2026-09-01', '2026-09-03', '2026-09-04']);
  });

  it('K-02 c.5 EXDATE avec TZID en liste, comparé à l’instant : l’instance exclue disparaît', () => {
    const text = ics(...vevent('UID:s', 'DTSTART;TZID=Europe/Paris:20260901T180000', 'DTEND;TZID=Europe/Paris:20260901T190000', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;TZID=Europe/Paris:20260901T180000,20260903T180000', 'SUMMARY:S'));
    expect(read(text).map((event) => event.startUtc)).toEqual(['2026-09-02T16:00:00Z']);
  });

  it('K-02 c.5 exception déplacée d’un autre jour : une seule instance, avec ses horaires', () => {
    const text = ics(
      ...vevent('UID:s', 'DTSTART:20260901T080000Z', 'DTEND:20260901T090000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:S'),
      ...vevent('UID:s', 'RECURRENCE-ID:20260902T080000Z', 'DTSTART:20260905T120000Z', 'DTEND:20260905T130000Z', 'SUMMARY:S déplacé'),
    );
    const events = read(text);
    expect(events.map((event) => [event.title, event.startUtc])).toEqual([
      ['S', '2026-09-01T08:00:00Z'],
      ['S', '2026-09-03T08:00:00Z'],
      ['S déplacé', '2026-09-05T12:00:00Z'],
    ]);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(3);
  });

  it('K-02 c.5 série sans fin (ni COUNT ni UNTIL) : bornée par la plage, identifiants uniques, rapide', () => {
    const started = Date.now();
    const events = read(ics(...vevent('UID:inf', 'DTSTART:20260101T080000Z', 'DTEND:20260101T090000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Tous les jours')));
    expect(events).toHaveLength(730);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(730);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('K-02 c.5 RRULE mal formée (INTERVAL=0, COUNT=-1, FREQ inconnue) : premier événement seul, sans boucle', () => {
    for (const rule of ['FREQ=DAILY;INTERVAL=0', 'FREQ=DAILY;COUNT=-1', 'FREQ=SECONDLY', 'garbage', 'FREQ=DAILY;BYDAY=XX']) {
      const events = read(ics(...vevent('UID:r', 'DTSTART:20260924T080000Z', 'DTEND:20260924T090000Z', `RRULE:${rule}`, 'SUMMARY:R')));
      expect(events.map((event) => event.startUtc)).toEqual(['2026-09-24T08:00:00Z']);
    }
  });

  it('K-02 c.5 textes illisibles : liste vide, sans exception', () => {
    for (const text of ['', '\u0000\u0001', 'BEGIN:VCALENDAR', ics('BEGIN:VEVENT', 'UID:x', 'DTSTART:xx', 'END:VEVENT'), ics(...vevent('DTSTART:20260924T080000Z'))]) {
      expect(read(text)).toEqual([]);
    }
  });
});

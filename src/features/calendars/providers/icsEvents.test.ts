import { describe, expect, it } from 'vitest';
import { CALDAV_FIXTURE_CALENDARS } from '../../../../tests/sim';
import { eventsFromIcs } from './icsEvents';
import { parseDuration, parseIcs, parseIcsTime, unescapeText } from './ics';

const RANGE = { fromMs: Date.parse('2026-08-01T00:00:00Z'), toMs: Date.parse('2027-12-01T00:00:00Z') };
const PARIS = 'Europe/Paris';

const ics = (...lines: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const vevent = (...lines: string[]): string[] => ['BEGIN:VEVENT', 'DTSTAMP:20260901T000000Z', ...lines, 'END:VEVENT'];
const read = (text: string, tz = PARIS, range = RANGE) => eventsFromIcs('cal', text, range, tz);
const starts = (text: string, tz = PARIS, range = RANGE): string[] => read(text, tz, range).map((event) => event.startUtc);

describe('analyse iCalendar de base', () => {
  it('déplie les lignes, lit les paramètres entre guillemets et décode le texte', () => {
    const root = parseIcs(ics('BEGIN:VEVENT', 'UID:1', 'SUMMARY:Rendez-vous\\, avec\\nsaut', ' suite de ligne', 'DTSTART;TZID="Europe/Paris":20260924T190000', 'END:VEVENT'));
    const event = root?.children[0];
    expect(event?.props.find((property) => property.name === 'SUMMARY')?.value).toBe('Rendez-vous\\, avec\\nsaut' + 'suite de ligne');
    expect(event?.props.find((property) => property.name === 'DTSTART')?.params['TZID']).toBe('Europe/Paris');
    expect(unescapeText('a\\, b\\; c\\n\\\\')).toBe('a, b; c\n\\');
  });

  it('refuse un texte sans VCALENDAR ou aux composants mal emboîtés', () => {
    expect(parseIcs('')).toBeNull();
    expect(parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n')).toBeNull();
    expect(parseIcs('BEGIN:VEVENT\r\nEND:VEVENT\r\n')).toBeNull();
    expect(read('pas du texte iCalendar')).toEqual([]);
  });

  it('dates, durées', () => {
    expect(parseIcsTime({ name: 'DTSTART', params: {}, value: '20260230' })).toBeNull();
    expect(parseIcsTime({ name: 'DTSTART', params: {}, value: 'demain' })).toBeNull();
    expect(parseIcsTime({ name: 'DTSTART', params: {}, value: '20260924T250000' })).toBeNull();
    expect(parseDuration('PT1H30M')).toBe(5_400_000);
    expect(parseDuration('P1W')).toBe(7 * 86_400_000);
    expect(parseDuration('-P1DT2H')).toBe(-(26 * 3_600_000));
    expect(parseDuration('P')).toBeNull();
    expect(parseDuration('une heure')).toBeNull();
  });
});

describe('événements simples (K-02 critère 5)', () => {
  it('heure avec TZID → UTC (19:00 Paris en heure d’été = 17:00Z)', () => {
    const [event] = read(ics(...vevent('UID:a', 'DTSTART;TZID=Europe/Paris:20260924T190000', 'DTEND;TZID=Europe/Paris:20260924T210000', 'SUMMARY:Dîner chez Leïla')));
    expect(event).toEqual({ calendarId: 'cal', externalId: 'a', title: 'Dîner chez Leïla', startUtc: '2026-09-24T17:00:00Z', endUtc: '2026-09-24T19:00:00Z', allDay: false });
  });

  it('heure UTC, durée à la place de la fin, sans fin', () => {
    const [utc, duration, none] = read(
      ics(...vevent('UID:a', 'DTSTART:20260924T080000Z', 'DTEND:20260924T090000Z', 'SUMMARY:A'), ...vevent('UID:b', 'DTSTART:20260925T080000Z', 'DURATION:PT45M', 'SUMMARY:B'), ...vevent('UID:c', 'DTSTART:20260926T080000Z', 'SUMMARY:C')),
    );
    expect(utc).toMatchObject({ startUtc: '2026-09-24T08:00:00Z', endUtc: '2026-09-24T09:00:00Z' });
    expect(duration).toMatchObject({ startUtc: '2026-09-25T08:00:00Z', endUtc: '2026-09-25T08:45:00Z' });
    expect(none).toMatchObject({ startUtc: '2026-09-26T08:00:00Z', endUtc: null });
  });

  it('heure flottante : fuseau de l’appareil, qui change le résultat', () => {
    const text = ics(...vevent('UID:f', 'DTSTART:20260926T093000', 'DTEND:20260926T103000', 'SUMMARY:Marché'));
    expect(read(text, 'Europe/Paris')[0]).toMatchObject({ startUtc: '2026-09-26T07:30:00Z', endUtc: '2026-09-26T08:30:00Z' });
    expect(read(text, 'America/New_York')[0]).toMatchObject({ startUtc: '2026-09-26T13:30:00Z' });
    expect(read(text, 'Fuseau/Inconnu')[0]).toMatchObject({ startUtc: '2026-09-26T09:30:00Z' });
  });

  it('journée entière : dates civiles sans décalage, fin exclue ; sans fin : un jour', () => {
    const [week, single] = read(ics(...vevent('UID:w', 'DTSTART;VALUE=DATE:20260927', 'DTEND;VALUE=DATE:20260930', 'SUMMARY:Week-end à Tunis'), ...vevent('UID:s', 'DTSTART;VALUE=DATE:20261001', 'SUMMARY:Férié')), 'America/Los_Angeles');
    expect(week).toEqual({ calendarId: 'cal', externalId: 'w', title: 'Week-end à Tunis', startUtc: '2026-09-27', endUtc: '2026-09-30', allDay: true });
    expect(single).toMatchObject({ startUtc: '2026-10-01', endUtc: '2026-10-02', allDay: true });
  });

  it('annulé exclu ; sans titre : titre vide ; sans UID ou sans début : ignoré', () => {
    const events = read(
      ics(
        ...vevent('UID:x', 'DTSTART:20260928T080000Z', 'STATUS:CANCELLED', 'SUMMARY:Annulé'),
        ...vevent('UID:y', 'DTSTART:20261001T120000Z', 'DTEND:20261001T130000Z'),
        ...vevent('DTSTART:20261002T120000Z', 'SUMMARY:Sans UID'),
        ...vevent('UID:z', 'SUMMARY:Sans début'),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ externalId: 'y', title: '' });
  });

  it('plage : ne rend que ce qui la recoupe (fin exclue, début avant la plage mais fin dedans)', () => {
    const text = ics(...vevent('UID:a', 'DTSTART:20260801T230000Z', 'DTEND:20260802T010000Z', 'SUMMARY:A'), ...vevent('UID:b', 'DTSTART:20260731T230000Z', 'DTEND:20260801T000000Z', 'SUMMARY:B'), ...vevent('UID:c', 'DTSTART:20260731T230000Z', 'DTEND:20260801T010000Z', 'SUMMARY:C'));
    expect(read(text).map((event) => event.externalId)).toEqual(['a', 'c']);
  });

  it('fuseau Windows et VTIMEZONE personnalisé', () => {
    const windows = ics(...vevent('UID:w', 'DTSTART;TZID=Romance Standard Time:20260924T190000', 'DTEND;TZID=Romance Standard Time:20260924T200000', 'SUMMARY:W'));
    expect(read(windows, 'UTC')[0]).toMatchObject({ startUtc: '2026-09-24T17:00:00Z' });
    const custom = ics(
      'BEGIN:VTIMEZONE',
      'TZID:Mon Fuseau',
      'BEGIN:DAYLIGHT',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'DTSTART:19700329T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'DTSTART:19701025T030000',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
      'END:STANDARD',
      'END:VTIMEZONE',
      ...vevent('UID:s', 'DTSTART;TZID=Mon Fuseau:20260924T190000', 'DTEND;TZID=Mon Fuseau:20260924T200000', 'SUMMARY:Été'),
      ...vevent('UID:h', 'DTSTART;TZID=Mon Fuseau:20261224T190000', 'DTEND;TZID=Mon Fuseau:20261224T200000', 'SUMMARY:Hiver'),
    );
    expect(starts(custom, 'UTC')).toEqual(['2026-09-24T17:00:00Z', '2026-12-24T18:00:00Z']);
  });
});

describe('séries (K-02 critère 5)', () => {
  it('RRULE hebdomadaire avec EXDATE : développée sur la plage, sans l’exclue, identifiants stables', () => {
    const text = ics(...vevent('UID:piscine', 'DTSTART;TZID=Europe/Paris:20260922T180000', 'DTEND;TZID=Europe/Paris:20260922T190000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;TZID=Europe/Paris:20260929T180000', 'SUMMARY:Piscine'));
    const events = read(text);
    expect(events.map((event) => event.startUtc)).toEqual(['2026-09-22T16:00:00Z', '2026-10-06T16:00:00Z', '2026-10-13T16:00:00Z']);
    expect(events[0]?.externalId).toBe('piscine#20260922T160000Z');
    expect(events[0]?.endUtc).toBe('2026-09-22T17:00:00Z');
  });

  it('l’heure locale reste la même de part et d’autre du changement d’heure (série en TZID)', () => {
    const text = ics(...vevent('UID:s', 'DTSTART;TZID=Europe/Paris:20261020T190000', 'DTEND;TZID=Europe/Paris:20261020T200000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:S'));
    expect(starts(text, 'UTC')).toEqual(['2026-10-20T17:00:00Z', '2026-10-27T18:00:00Z', '2026-11-03T18:00:00Z']);
  });

  it('même identifiant que des instances développées par le serveur (expand)', () => {
    const expanded = ics(...vevent('UID:piscine', 'RECURRENCE-ID:20260922T160000Z', 'DTSTART:20260922T160000Z', 'DTEND:20260922T170000Z', 'SUMMARY:Piscine'));
    const master = ics(...vevent('UID:piscine', 'DTSTART;TZID=Europe/Paris:20260922T180000', 'DTEND;TZID=Europe/Paris:20260922T190000', 'RRULE:FREQ=WEEKLY;COUNT=1', 'SUMMARY:Piscine'));
    expect(read(expanded)[0]?.externalId).toBe(read(master)[0]?.externalId);
  });

  it('exception RECURRENCE-ID déplacée, exception annulée, UNTIL', () => {
    const text = ics(
      ...vevent('UID:s', 'DTSTART:20260922T080000Z', 'DTEND:20260922T090000Z', 'RRULE:FREQ=DAILY;UNTIL=20260925T080000Z', 'SUMMARY:Série'),
      ...vevent('UID:s', 'RECURRENCE-ID:20260923T080000Z', 'DTSTART:20260923T100000Z', 'DTEND:20260923T110000Z', 'SUMMARY:Série déplacée'),
      ...vevent('UID:s', 'RECURRENCE-ID:20260924T080000Z', 'DTSTART:20260924T080000Z', 'STATUS:CANCELLED', 'SUMMARY:Série'),
    );
    expect(read(text).map((event) => [event.startUtc, event.title])).toEqual([
      ['2026-09-22T08:00:00Z', 'Série'],
      ['2026-09-25T08:00:00Z', 'Série'],
      ['2026-09-23T10:00:00Z', 'Série déplacée'],
    ]);
  });

  it('série annulée : rien ; série journée entière annuelle (anniversaire) ; MONTHLY dernier vendredi', () => {
    expect(read(ics(...vevent('UID:s', 'DTSTART:20260922T080000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'STATUS:CANCELLED')))).toEqual([]);
    const birthday = ics(...vevent('UID:b', 'DTSTART;VALUE=DATE:20200315', 'DTEND;VALUE=DATE:20200316', 'RRULE:FREQ=YEARLY', 'SUMMARY:Anniversaire'));
    expect(read(birthday, PARIS, { fromMs: Date.parse('2026-01-01T00:00:00Z'), toMs: Date.parse('2028-01-01T00:00:00Z') }).map((event) => [event.startUtc, event.endUtc])).toEqual([
      ['2026-03-15', '2026-03-16'],
      ['2027-03-15', '2027-03-16'],
    ]);
    const lastFriday = ics(...vevent('UID:m', 'DTSTART:20260925T090000Z', 'DTEND:20260925T100000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', 'SUMMARY:Revue'));
    expect(starts(lastFriday)).toEqual(['2026-09-25T09:00:00Z', '2026-10-30T09:00:00Z', '2026-11-27T09:00:00Z']);
  });

  it('RDATE ajoute une occurrence ; règle non gérée : premier événement seul', () => {
    const rdate = ics(...vevent('UID:r', 'DTSTART:20260922T080000Z', 'DTEND:20260922T090000Z', 'RRULE:FREQ=DAILY;COUNT=1', 'RDATE:20261001T080000Z', 'SUMMARY:R'));
    expect(starts(rdate)).toEqual(['2026-09-22T08:00:00Z', '2026-10-01T08:00:00Z']);
    const hourly = ics(...vevent('UID:h', 'DTSTART:20260922T080000Z', 'DTEND:20260922T090000Z', 'RRULE:FREQ=HOURLY;COUNT=5', 'SUMMARY:H'));
    expect(starts(hourly)).toEqual(['2026-09-22T08:00:00Z']);
  });

  it('500 événements : analyse en moins de 500 ms', () => {
    const events = Array.from({ length: 500 }, (_, index) => vevent(`UID:e${String(index)}`, `DTSTART:2026${String(10 + (index % 3))}${String(1 + (index % 28)).padStart(2, '0')}T080000Z`, 'DTEND:20261201T090000Z', `SUMMARY:E${String(index)}`)).flat();
    const started = performance.now();
    const found = read(ics(...events));
    expect(found).toHaveLength(500);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('fixtures du simulateur CalDAV', () => {
  it('chaque objet donne les événements attendus', () => {
    const family = CALDAV_FIXTURE_CALENDARS[0];
    const all = (family?.objects ?? []).flatMap((object) => eventsFromIcs('famille', object.ics, RANGE, PARIS));
    expect(all.map((event) => [event.externalId, event.title, event.startUtc, event.endUtc])).toEqual([
      ['diner-1', 'Dîner chez Leïla', '2026-09-24T17:00:00Z', '2026-09-24T19:00:00Z'],
      ['flottant-1', 'Marché', '2026-09-26T07:30:00Z', '2026-09-26T08:30:00Z'],
      ['weekend-1', 'Week-end à Tunis', '2026-09-27', '2026-09-30'],
      ['piscine#20260922T160000Z', 'Piscine', '2026-09-22T16:00:00Z', '2026-09-22T17:00:00Z'],
      ['piscine#20260929T160000Z', 'Piscine', '2026-09-29T16:00:00Z', '2026-09-29T17:00:00Z'],
      ['sans-titre-1', '', '2026-10-01T12:00:00Z', '2026-10-01T13:00:00Z'],
    ]);
  });
});

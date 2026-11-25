import { describe, expect, it } from 'vitest';
import { bestMatch, payeeDisplayName, payeeKey } from './payee-match';

const payee = (raw: string) => ({ key: payeeKey(raw), name: payeeDisplayName(raw) });

describe('payeeKey / payeeDisplayName', () => {
  it.each([
    ['BIEDRONKA 1234 WARSZAWA', 'biedronka', 'Biedronka'],
    ['BIEDRONKA 5678 KRAKOW', 'biedronka', 'Biedronka'],
    ['Biedronka', 'biedronka', 'Biedronka'],
    ['ZAKUP PRZY UŻYCIU KARTY 4321********1234 BIEDRONKA 1234', 'biedronka', 'Biedronka'],
    ['BIEDRONKA NR 12 Łódź', 'biedronka', 'Biedronka'],
    ['JMP S.A. BIEDRONKA 1234', 'biedronka', 'Biedronka'],
    // PKO's long descriptions.
    [
      'Tytuł: 000498849 74230784290137284 ZAKUP PRZY UŻYCIU KARTY Lokalizacja: Adres: JMP S.A. BIEDRONKA 1234 Miasto: WARSZAWA Kraj: POLSKA',
      'biedronka',
      'Biedronka',
    ],
    ['Tytuł: 000498849 ZAKUP PRZY UŻYCIU KARTY Lokalizacja: Adres: ŻABKA Z1234 K.1 Miasto: Kraków Kraj: POLSKA', 'zabka', 'Żabka'],
    // Diacritics only leave the key.
    ['ŻABKA Z5678 K.1 WARSZAWA', 'zabka', 'Żabka'],
    ['ZABKA Z5678', 'zabka', 'Zabka'],
    ['Żabka Polska sp. z o.o.', 'zabka', 'Żabka'],
    // Revolut's clean names.
    ['Uber', 'uber', 'Uber'],
    ["McDonald's", 'mcdonalds', "McDonald's"],
    ['eBay', 'ebay', 'eBay'],
    ['UBER *TRIP HELP.UBER.COM', 'uber trip', 'UBER TRIP'],
    ['Allegro.pl sp. z o.o.', 'allegro', 'Allegro'],
    // Acronyms of up to 4 capitals stay.
    ['PKP INTERCITY S.A.', 'pkp intercity', 'PKP Intercity'],
    ['IKEA RETAIL SP. Z O.O. SP.K.', 'ikea retail', 'IKEA Retail'],
    ['Płatność kartą 12,99 PLN 2026-11-18 ORLEN STACJA', 'orlen stacja', 'Orlen Stacja'],
    ['CARD PAYMENT SPOTIFY P1234567 www.spotify.com', 'spotify', 'Spotify'],
    ['Przelew na telefon BLIK', 'przelew na telefon blik', 'Przelew na telefon BLIK'],
    ['ACME Sp. z o.o.', 'acme', 'ACME'],
    ['Warszawa', 'warszawa', 'Warszawa'],
  ])('%s → %s (%s)', (raw, key, name) => {
    expect(payee(raw)).toEqual({ key, name });
  });
});

describe('bestMatch', () => {
  const candidates = (...names: [string, string | null][]) =>
    names.map(([name, lastUsed]) => ({ name, key: payeeKey(name), lastUsed }));
  const match = (raw: string, list: ReturnType<typeof candidates>) => bestMatch(payeeKey(raw), list)?.name ?? null;

  it('takes the same key first, the most recently used of several', () => {
    const list = candidates(['BIEDRONKA 1234 WARSZAWA', '2026-10-01'], ['Biedronka', '2026-11-01'], ['Lidl', null]);
    expect(match('BIEDRONKA 5678 KRAKOW', list)).toBe('Biedronka');
    expect(match('Lidl sp. z o.o.', list)).toBe('Lidl');
  });

  it('matches similar names: the first word, most words, or a prefix of at least 4 letters', () => {
    const list = candidates(['Uber', null], ['Orlen Stacja Paliw', null], ['Media Expert', null]);
    expect(match('UBER *TRIP', list)).toBe('Uber');
    expect(match('ORLEN STACJA PALIW NR 4', list)).toBe('Orlen Stacja Paliw');
    expect(match('ORLEN STACJA', list)).toBe('Orlen Stacja Paliw');
    expect(match('Media Expert Terg', list)).toBe('Media Expert');
  });

  it('prefers the most similar, then the most recently used', () => {
    const list = candidates(['Biedronka Express', '2026-11-01'], ['Biedronka Codzienna', '2026-11-10'], ['Biedronka Codzienna Plus', '2026-11-20']);
    expect(match('BIEDRONKA CODZIENNA', list)).toBe('Biedronka Codzienna');
    expect(match('BIEDRONKA 1234', list)).toBe('Biedronka Codzienna');
  });

  it("doesn't match different names, or short keys other than exactly", () => {
    expect(match('ORLEN 1234', candidates(['Orange', null]))).toBeNull();
    expect(match('ORANGE POLSKA S.A.', candidates(['Orlen', null]))).toBeNull();
    expect(match('LOT', candidates(['Lotos', null]))).toBeNull();
    expect(match('LOTOS 123', candidates(['Lot', null]))).toBeNull();
    expect(match('BP 123', candidates(['BP Stacja', null]))).toBeNull();
    expect(match('BP', candidates(['BP', null]))).toBe('BP');
    expect(match('Jan Kowalski', candidates(['Jan Nowak', null]))).toBeNull();
    expect(match('ANNA KOWALSKA', candidates(['Anna Nowak', null]))).toBeNull();
  });
});

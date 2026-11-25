/**
 * YNAB-like payee matching for bank imports: the many ways a bank names one shop ("BIEDRONKA 1234 WARSZAWA",
 * "ZAKUP PRZY UŻYCIU KARTY 4321********1234 BIEDRONKA 1234") reduce to one comparison key ("biedronka") and a display
 * name for a new payee ("Biedronka"). Pure; `bestMatch` picks the payee an import belongs to.
 */

interface Token {
  /** As the bank wrote it, Polish letters kept. */
  word: string;
  /** Lowercase, without diacritics or apostrophes. */
  key: string;
}

const fold = (text: string) =>
  text
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/\p{M}/gu, '');

const phrases = (list: string[]) => list.map((p) => p.split(' ')).sort((a, b) => b.length - a.length);

/** Bank boilerplate, compared folded, dropped wherever it appears. */
const BOILERPLATE = phrases([
  'zakup przy uzyciu karty',
  'platnosc karta',
  'transakcja karta',
  'card payment',
  'przelew na telefon',
  'na telefon',
  'przelew przychodzacy',
  'przelew wychodzacy',
  'przelew',
  'transfer to',
  'transfer from',
  'blik',
  'apple pay',
  'google pay',
  'tytul',
  'lokalizacja',
  'nr',
]);

/** Legal forms: what follows one ("JMP S.A. BIEDRONKA") is the brand, else what comes before it. */
const LEGAL = phrases([
  'sp z o o',
  'spolka z o o',
  'spolka z ograniczona odpowiedzialnoscia',
  'spolka akcyjna',
  'sp k',
  'sp j',
  's a',
  'sa',
  'ltd',
  'gmbh',
  'inc',
  'llc',
]);

/** Large Polish cities (and the country), dropped from the end of a name. */
const PLACES = new Set([
  'warszawa',
  'warsaw',
  'krakow',
  'lodz',
  'wroclaw',
  'poznan',
  'gdansk',
  'szczecin',
  'bydgoszcz',
  'lublin',
  'bialystok',
  'katowice',
  'gdynia',
  'czestochowa',
  'radom',
  'torun',
  'sosnowiec',
  'kielce',
  'rzeszow',
  'gliwice',
  'olsztyn',
  'opole',
  'sopot',
  'polska',
  'poland',
]);

const CURRENCY = String.raw`(?:pln|zł|zl|eur|€|usd|\$|gbp|£|chf)`;
const NOISE = [
  /https?:\/\/\S+|www\.\S+|\S+@\S+/giu,
  /\d{4}\*+\d{4}|x{4,}/giu,
  /\d{1,4}[-./]\d{1,2}[-./]\d{2,4}/gu,
  new RegExp(String.raw`\d+(?:[.,]\d+)?\s*${CURRENCY}(?![\p{L}])|(?<![\p{L}])${CURRENCY}\s*\d+(?:[.,]\d+)?`, 'giu'),
  /\d{3,}/gu,
];

function tokensOf(text: string): Token[] {
  return text
    .split(/[^\p{L}\p{N}&']+/u)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter((word) => word !== '')
    .map((word) => ({ word, key: fold(word).replace(/'/g, '') }));
}

/** Splits `tokens` where one of `list` appears, leaving the phrases out. */
function split(tokens: Token[], list: string[][]): Token[][] {
  const segments: Token[][] = [[]];
  for (let i = 0; i < tokens.length; ) {
    const found = list.find((p) => p.every((key, j) => tokens[i + j]?.key === key));
    if (found) {
      segments.push([]);
      i += found.length;
    } else segments.at(-1)!.push(tokens[i++]!);
  }
  return segments;
}

/** The words that name the payee; empty when nothing but boilerplate is left. */
function cleanTokens(raw: string): Token[] {
  // PKO's long descriptions: "Tytuł: … Lokalizacja: Adres: JMP S.A. BIEDRONKA 1234 Miasto: WARSZAWA Kraj: POLSKA".
  let text = /adres:\s*(.+?)\s*(?:miasto:|kraj:|$)/iu.exec(raw)?.[1] ?? raw;
  text = text.replace(NOISE[0]!, ' ');
  // A bare domain stands for its name: "HELP.UBER.COM" → "UBER", "allegro.pl" → "allegro".
  text = text.replace(/(?:[\p{L}\d-]+\.)*([\p{L}\d-]+)\.(?:com|pl|eu|net|org|io|de)(?![\p{L}\d])/giu, '$1');
  for (const pattern of NOISE.slice(1)) text = text.replace(pattern, ' ');

  const words = split(tokensOf(text), BOILERPLATE).flat();
  const segments = split(words, LEGAL)
    .map((s) => s.filter((t) => t.key.length > 1 && !/^\d+$/.test(t.key)))
    .filter((s) => s.some((t) => !PLACES.has(t.key)));
  let tokens = segments.at(-1) ?? [];
  while (tokens.length > 1 && PLACES.has(tokens.at(-1)!.key)) tokens = tokens.slice(0, -1);
  const seen = new Set<string>();
  return tokens.filter((t) => !seen.has(t.key) && seen.add(t.key));
}

/** The comparison key of a payee name or bank text: "ŻABKA Z1234 K.1 WARSZAWA" → "zabka". */
export function payeeKey(raw: string): string {
  const tokens = cleanTokens(raw);
  return (tokens.length > 0 ? tokens : tokensOf(raw)).map((t) => t.key).join(' ');
}

/** Title case, except words written in mixed case ("eBay") and acronyms of up to 4 capitals ("PKP", "IKEA"). */
function displayWord(word: string): string {
  const upper = word === word.toUpperCase();
  const lower = word === word.toLowerCase();
  if (upper && word.length <= 4) return word;
  if (!upper && !lower) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** The name a new payee gets: "BIEDRONKA 1234 WARSZAWA" → "Biedronka"; bare boilerplate keeps the bank's text. */
export function payeeDisplayName(raw: string): string {
  const tokens = cleanTokens(raw);
  return tokens.length > 0 ? tokens.map((t) => displayWord(t.word)).join(' ') : raw.trim();
}

export interface PayeeCandidate {
  /** `payeeKey` of the payee's name. */
  key: string;
  /** The date of its latest transaction (ISO), null if unused. */
  lastUsed: string | null;
}

/** Shorter keys only ever match exactly. */
const MIN_FUZZY = 4;

function dice(a: Set<string>, b: Set<string>): number {
  let common = 0;
  for (const token of a) if (b.has(token)) common++;
  return (2 * common) / (a.size + b.size);
}

/**
 * The payee an import's key belongs to: one with the same key, else a similar one (the key's first word, a token-set
 * Dice similarity of at least 0.8, or one key starting with the other), the most similar first; ties go to the most
 * recently used. Null when none is close enough.
 */
export function bestMatch<T extends PayeeCandidate>(key: string, candidates: T[]): T | null {
  if (key === '') return null;
  const recent = (a: T, b: T) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '');
  const exact = candidates.filter((c) => c.key === key).sort(recent);
  if (exact.length > 0 || key.length < MIN_FUZZY) return exact[0] ?? null;
  const tokens = new Set(key.split(' '));
  const first = key.split(' ')[0];
  const scored = candidates.flatMap((c) => {
    if (c.key.length < MIN_FUZZY) return [];
    const score = dice(tokens, new Set(c.key.split(' ')));
    const similar = score >= 0.8 || c.key === first || key.startsWith(c.key) || c.key.startsWith(key);
    return similar ? [{ c, score }] : [];
  });
  scored.sort((a, b) => b.score - a.score || recent(a.c, b.c));
  return scored[0]?.c ?? null;
}

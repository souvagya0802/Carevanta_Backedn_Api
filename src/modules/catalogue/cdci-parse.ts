/**
 * Parsing helpers for the Common Drug Codes for India (CDCI) flat files.
 * A CDCI brand name looks like
 *   "Safedox (cefpodoxime) 200 mg film-coated oral tablet"
 *   "Flucret (caffeine and paracetamol) 30 mg + 500 mg oral tablet"
 * i.e. <name> (<composition>) <strength> <dose form>. Some rows have no
 * composition ("Xet 30 mg oral tablet") or no strength ("Covaxin vaccine").
 */

export interface ParsedBrand {
  name: string;
  composition: string | null;
  strength: string | null;
  dosageForm: string | null;
}

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const UNIT = String.raw`(?:(?:million|lakh|billion)\s+)?[\p{L}%]+(?:\s*\/\s*(?:\d+(?:\.\d+)?\s*)?[\p{L}]+)?`;
const ONE = String.raw`${NUM}\s*${UNIT}`;
const STRENGTH_RE = new RegExp(String.raw`^(${ONE}(?:\s*\+\s*${ONE})*)(?=\s|$)`, 'u');
const SMALL_WORDS = new Set(['and', 'of', 'in', 'with', 'for', 'or']);

export function normaliseSpace(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}

/** Title Case each word; keeps short joining words lower case and the rest of each word as-is. */
export function titleCase(s: string): string {
  return normaliseSpace(s)
    .split(' ')
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toLocaleUpperCase('en-IN') + w.slice(1)))
    .join(' ');
}

function splitStrength(rest: string): { strength: string | null; dosageForm: string | null } {
  const text = normaliseSpace(rest);
  const m = STRENGTH_RE.exec(text);
  if (!m) return { strength: null, dosageForm: text ? titleCase(text) : null };
  const strength = normaliseSpace(m[1]!).replace(/\s*\+\s*/gu, ' + ');
  const form = text.slice(m[0].length).trim();
  return { strength, dosageForm: form ? titleCase(form) : null };
}

/**
 * Parses a CDCI brand name. Some generically named brands repeat the supplier at the end
 * ("Paracetamol (paracetamol) 500 mg oral tablet Adcco Limited"); pass the supplier name to drop it.
 */
export function parseBrandName(raw: string, supplier?: string | null): ParsedBrand {
  const p = parseRaw(raw);
  const sup = supplier ? normaliseSpace(supplier).toLocaleLowerCase('en-IN') : '';
  if (sup && p.dosageForm && p.dosageForm.toLocaleLowerCase('en-IN').endsWith(' ' + sup)) {
    p.dosageForm = p.dosageForm.slice(0, p.dosageForm.length - sup.length).trim() || null;
  }
  return p;
}

function parseRaw(raw: string): ParsedBrand {
  const text = normaliseSpace(raw.normalize('NFC'));
  // The composition is the last top-level parenthesised group; anything before it is the brand name
  // (which may itself contain a group such as "Lot (Entod)").
  const close = text.lastIndexOf(')');
  if (close > 0) {
    let depth = 0;
    let open = -1;
    for (let i = close; i >= 0; i--) {
      if (text[i] === ')') depth++;
      else if (text[i] === '(' && --depth === 0) { open = i; break; }
    }
    if (open > 0) {
      const name = text.slice(0, open).trim();
      const composition = text.slice(open + 1, close).trim();
      if (name) {
        return { name, composition: composition ? titleCase(composition) : null, ...splitStrength(text.slice(close + 1)) };
      }
    }
  }
  // No composition: look for the first word that starts a strength.
  const words = text.split(' ');
  for (let i = 1; i < words.length; i++) {
    if (/^\d/u.test(words[i]!)) {
      const tail = words.slice(i).join(' ');
      if (STRENGTH_RE.test(tail)) return { name: words.slice(0, i).join(' '), composition: null, ...splitStrength(tail) };
    }
  }
  return { name: text, composition: null, strength: null, dosageForm: null };
}

/** Lower-case search key: name plus composition, single-spaced. Used for prefix search. */
export function searchKey(name: string, composition?: string | null): string {
  return normaliseSpace(`${name} ${composition ?? ''}`).toLocaleLowerCase('en-IN');
}

/** Key used to detect duplicate proposals: name + strength + form, lower-case, punctuation-free. */
export function dedupeKey(name: string, strength?: string | null, form?: string | null): string {
  const n = (s?: string | null) => normaliseSpace((s ?? '').toLocaleLowerCase('en-IN').replace(/[^\p{L}\p{N}%/.+]+/gu, ' '));
  return `${n(name)}|${n(strength).replace(/\s+/gu, '')}|${n(form)}`;
}

/** Splits one TSV line, dropping the trailing empty cell some CDCI lines have. */
export function splitTsv(line: string): string[] {
  return line.replace(/\r$/u, '').split('\t').map((c) => c.trim());
}

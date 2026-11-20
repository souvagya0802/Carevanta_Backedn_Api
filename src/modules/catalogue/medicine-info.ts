/**
 * Medicine substitutes and patient-facing information.
 *
 * `compositionKey` is the "same salt, same strength, same form" key: medicines sharing a key are
 * substitutes of each other (shown to patients as information only; the platform never substitutes,
 * the pharmacist decides). The key is `ingredients|strengths|form family`, e.g.
 *   "caffeine+paracetamol|30mg+500mg|tablet".
 * Ingredients are lower-cased, trimmed and sorted; each strength stays paired with its ingredient when
 * the counts match. Mass units are normalised to mg ("0.5 g" = "500 mg" = "500mg", "500 mcg" = "0.5 mg");
 * anything the parser is unsure about keeps its exact (lower-cased, space-free) text. The form family
 * treats "Oral Tablet" and "Film-coated Oral Tablet" alike, but keeps release type (prolonged-release,
 * gastro-resistant), dispersible / chewable / effervescent and route (eye, ear, cutaneous) apart.
 *
 * The information builder turns CDCI GenericMaster / SubstanceMaster rows into the Medicine info fields.
 */

const low = (s: string | null | undefined) => (s ?? '').normalize('NFKC').toLocaleLowerCase('en-IN').replace(/\s+/gu, ' ').trim();

/** Ingredients of a composition text ("Caffeine and Paracetamol", "Paracetamol + Caffeine", "a, b"), lower-cased, in the given order. */
export function ingredientsOf(composition: string | null | undefined): string[] {
  return low(composition)
    .split(/\s*(?:\+|,|;|&|\band\b)\s*/u)
    .map((s) => s.replace(/[^\p{L}\p{N}%/.\-() ]+/gu, ' ').replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

const MASS: Record<string, number> = { g: 1000, gm: 1000, gram: 1000, grams: 1000, mg: 1, milligram: 1, milligrams: 1, mcg: 0.001, ug: 0.001, microgram: 0.001, micrograms: 0.001 };
const VOLUME: Record<string, string> = { ml: 'ml', millilitre: 'ml', milliliter: 'ml', millilitres: 'ml', milliliters: 'ml' };
const UNIT_ALIAS: Record<string, string> = { iu: 'iu', 'i.u.': 'iu', 'i.u': 'iu', unit: 'unit', units: 'unit', 'u': 'unit' };
const tidyNumber = (n: number) => String(Number(n.toPrecision(12)));

/** One ingredient strength ("500 mg", "125 mg/5 mL", "50 mg/1 vial", "0.5 g") in canonical form, or its exact squashed text when unsure. */
export function normaliseStrengthPart(raw: string): string {
  // µ (micro sign) and μ (Greek mu) both mean micro; NFKC maps the micro sign to Greek mu.
  const s = low(raw).replace(/[µμ]/gu, 'u');
  const exact = s.replace(/\s+/gu, '');
  if (!s) return '';
  const m = /^(\d+(?:\.\d+)?)\s*([a-z.%]+)(?:\s*\/\s*(\d+(?:\.\d+)?)?\s*([a-z.]+))?$/u.exec(s);
  if (!m) return exact;
  const value = Number(m[1]);
  const unit = m[2]!;
  let head: string;
  if (MASS[unit] != null) head = `${tidyNumber(value * MASS[unit]!)}mg`;
  else if (VOLUME[unit]) head = `${tidyNumber(value)}ml`;
  else if (UNIT_ALIAS[unit]) head = `${tidyNumber(value)}${UNIT_ALIAS[unit]}`;
  else head = `${tidyNumber(value)}${unit}`;
  if (!m[4]) return head;
  const perQty = m[3] != null ? Number(m[3]) : 1;
  const perUnit = VOLUME[m[4]] ?? m[4];
  return `${head}/${perQty === 1 ? '' : tidyNumber(perQty)}${perUnit}`;
}

/** Strength parts of a strength text ("30 mg + 500 mg"), each normalised. */
export function strengthsOf(strength: string | null | undefined): string[] {
  return low(strength).split(/\s*\+\s*/u).map(normaliseStrengthPart).filter(Boolean);
}

const BASE_NOUN = /\b(tablets?|capsules?|syrup|suspension|solution|drops|cream|ointment|gel|lotion|injection|infusion|spray|powder|granules|suppository|pessary|patch|shampoo|lozenges?|emulsion|elixir|gum|paste|implant|inhaler|lyophilisate)\b/gu;
const COMPANY = /\b(private limited|limited|ltd|pvt|sangh|healthcare|therapeutics|pharma\w*|laboratories|remedies|industries)\b/u;

/** Dosage form family: "Film-coated Oral Tablet" → "tablet", "Oral Syrup" → "syrup", "Prolonged-release Oral Tablet" → "prolonged release tablet". */
export function doseFormFamily(form: string | null | undefined): string {
  let f = low(form).replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!f) return '';
  // Some CDCI rows carry the supplier after the form ("Oral Tablet Acme Laboratories Private Limited"); drop it.
  let lastEnd = -1;
  for (const m of f.matchAll(BASE_NOUN)) lastEnd = (m.index ?? 0) + m[0].length;
  if (lastEnd > 0 && lastEnd < f.length && COMPANY.test(f.slice(lastEnd))) f = f.slice(0, lastEnd);
  f = f
    .replace(/\b(tablets)\b/gu, 'tablet')
    .replace(/\b(capsules)\b/gu, 'capsule')
    .replace(/\blozenges\b/gu, 'lozenge')
    .replace(/\b(extended|sustained|controlled|modified) release\b/gu, 'prolonged release')
    .replace(/\b(delayed release|enteric coated)\b/gu, 'gastro resistant')
    .replace(/\bmouth dissolving\b/gu, 'orodispersible')
    .replace(/\b(film coated|sugar coated|uncoated|coated|oral|hard|soft)\b/gu, ' ');
  return f.replace(/\s+/gu, ' ').trim();
}

/**
 * Substitute key for a medicine, or null without a composition. Pure; safe to call on any create or update.
 * `caffeine+paracetamol|30mg+500mg|tablet`
 */
export function compositionKey(composition: string | null | undefined, strength: string | null | undefined, dosageForm: string | null | undefined): string | null {
  const ingredients = ingredientsOf(composition);
  if (!ingredients.length) return null;
  const strengths = strengthsOf(strength);
  const family = doseFormFamily(dosageForm);
  if (strengths.length === ingredients.length && ingredients.length > 1) {
    const pairs = ingredients.map((ing, i) => [ing, strengths[i]!] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
    return `${pairs.map((p) => p[0]).join('+')}|${pairs.map((p) => p[1]).join('+')}|${family}`;
  }
  return `${[...ingredients].sort().join('+')}|${strengths.join('+')}|${family}`;
}

/**
 * Key for a stored medicine. Rows added by hand or by a pharmacy without a composition carry the salt in
 * `genericName` ("Paracetamol"); CDCI generic names are full descriptions, so they never stand in for a composition.
 */
export function substituteKey(m: { composition: string | null; genericName?: string | null; source?: string | null; strength: string | null; dosageForm: string | null }): string | null {
  const composition = m.composition?.trim() ? m.composition : m.source && m.source !== 'CDCI' ? m.genericName ?? null : null;
  return compositionKey(composition, m.strength, m.dosageForm);
}

/** The parts of a key: same `ingredients` and `family` with a different `strength` are "Other strengths". */
export function keyParts(key: string): { ingredients: string; strength: string; family: string } | null {
  const parts = key.split('|');
  if (parts.length !== 3) return null;
  return { ingredients: parts[0]!, strength: parts[1]!, family: parts[2]! };
}

// ── Information ───────────────────────────────────────────────────────────

export const INFO_FIELDS = ['therapeuticClass', 'uses', 'howItWorks', 'sideEffects', 'contraindications', 'interactions'] as const;
export type MedicineInfo = Record<(typeof INFO_FIELDS)[number], string | null>;
/** Stored (snake_case) names of the info fields. */
export const INFO_COLUMNS: Record<(typeof INFO_FIELDS)[number], string> = { therapeuticClass: 'therapeutic_class', uses: 'uses', howItWorks: 'how_it_works', sideEffects: 'side_effects', contraindications: 'contraindications', interactions: 'interactions' };

export interface CdciGenericInfo { therapeuticRole: string; indication: string; contraIndication: string; interaction: string; substanceIds: string[] }
export interface CdciSubstanceInfo { name: string; description: string; toxicity: string }

const MAX_TEXT = 4000;
const clean = (s: string | null | undefined) => {
  const t = (s ?? '').replace(/\s+/gu, ' ').trim();
  return t ? t.slice(0, MAX_TEXT) : null;
};
const titleWord = (s: string) => s.replace(/(^|\s)(\p{L})/gu, (_m, sp: string, c: string) => sp + c.toLocaleUpperCase('en-IN'));

/** One text per ingredient: plain for a single ingredient, "Name:\ntext" paragraphs for a combination. */
function joinPerIngredient(subs: CdciSubstanceInfo[], pick: (s: CdciSubstanceInfo) => string, combination: boolean): string | null {
  const parts = subs.map((s) => ({ name: titleWord(s.name.toLocaleLowerCase('en-IN')), text: clean(pick(s)) })).filter((p): p is { name: string; text: string } => !!p.text);
  if (!parts.length) return null;
  if (!combination) return parts[0]!.text;
  return parts.map((p) => `${p.name}:\n${p.text}`).join('\n\n').slice(0, MAX_TEXT);
}

/** Medicine info from a CDCI generic and its substances; null when CDCI has nothing for it. */
export function cdciInfo(generic: CdciGenericInfo, substances: Map<string, CdciSubstanceInfo>): MedicineInfo | null {
  const subs = generic.substanceIds.map((id) => substances.get(id)).filter((s): s is CdciSubstanceInfo => !!s);
  const combination = generic.substanceIds.length > 1;
  const info: MedicineInfo = {
    therapeuticClass: clean(generic.therapeuticRole)?.slice(0, 200) ?? null,
    uses: clean(generic.indication),
    howItWorks: joinPerIngredient(subs, (s) => s.description, combination),
    sideEffects: joinPerIngredient(subs, (s) => s.toxicity, combination),
    contraindications: clean(generic.contraIndication),
    interactions: clean(generic.interaction),
  };
  return INFO_FIELDS.some((f) => info[f]) ? info : null;
}

export const SUBSTITUTE_NOTE = 'Ask your doctor or pharmacist before switching to a substitute.';
export const NOT_MEDICAL_ADVICE = 'This is not medical advice.';

/** "Information from CDCI, Government of India" / "Reviewed by Carevanta", or null when no information is stored. */
export function infoSourceLine(infoSource: string | null | undefined): string | null {
  if (infoSource === 'ADMIN') return 'Reviewed by Carevanta';
  if (infoSource === 'CDCI') return 'Information from CDCI, Government of India';
  return null;
}

import { describe, expect, it } from 'vitest';
import { dedupeKey, parseBrandName, searchKey, splitTsv, titleCase } from '../../src/modules/catalogue/cdci-parse.js';

describe('CDCI brand-name parsing', () => {
  it('splits a single-ingredient brand', () => {
    expect(parseBrandName('Safedox (cefpodoxime) 200 mg film-coated oral tablet')).toEqual({ name: 'Safedox', composition: 'Cefpodoxime', strength: '200 mg', dosageForm: 'Film-coated Oral Tablet' });
  });

  it('keeps every strength of a combination and joins ingredients in Title Case', () => {
    const p = parseBrandName('Flucret (caffeine and chlorphenamine maleate and paracetamol and phenylephrine hydrochloride) 30 mg + 4 mg + 500 mg + 10 mg oral tablet');
    expect(p).toEqual({ name: 'Flucret', composition: 'Caffeine and Chlorphenamine Maleate and Paracetamol and Phenylephrine Hydrochloride', strength: '30 mg + 4 mg + 500 mg + 10 mg', dosageForm: 'Oral Tablet' });
  });

  it('handles per-volume strengths and a bracketed company in the brand', () => {
    expect(parseBrandName('Terbokab-D (phenylephrine hydrochloride and dextromethorphan hydrobromide) 5 mg/5 ml + 10 mg/5 ml oral syrup')).toMatchObject({ name: 'Terbokab-D', strength: '5 mg/5 ml + 10 mg/5 ml', dosageForm: 'Oral Syrup' });
    expect(parseBrandName('Lot (Entod) (loteprednol etabonate) 5 mg/1 mL eye suspension')).toEqual({ name: 'Lot (Entod)', composition: 'Loteprednol Etabonate', strength: '5 mg/1 mL', dosageForm: 'Eye Suspension' });
    expect(parseBrandName('Oflostar(Cdl) (ofloxacin) 200 mg/100 mL solution for infusion')).toMatchObject({ name: 'Oflostar(Cdl)', strength: '200 mg/100 mL', dosageForm: 'Solution for Infusion' });
  });

  it('copes with no parentheses and no strength', () => {
    expect(parseBrandName('Xet 30 mg oral tablet')).toEqual({ name: 'Xet', composition: null, strength: '30 mg', dosageForm: 'Oral Tablet' });
    expect(parseBrandName('Covaxin vaccine')).toEqual({ name: 'Covaxin vaccine', composition: null, strength: null, dosageForm: null });
    expect(parseBrandName('Sputnik V vaccine').name).toBe('Sputnik V vaccine');
  });

  it('handles microgram units, decimals, unicode and odd spacing', () => {
    expect(parseBrandName('Thyrorite  (levothyroxine sodium) 12.5 µg oral tablet')).toEqual({ name: 'Thyrorite', composition: 'Levothyroxine Sodium', strength: '12.5 µg', dosageForm: 'Oral Tablet' });
    expect(parseBrandName('Seroflo (fluticasone and salmeterol) 250 mcg/actuation+25 mcg/actuation inhalation powder')).toMatchObject({ strength: '250 mcg/actuation + 25 mcg/actuation', dosageForm: 'Inhalation Powder' });
    expect(parseBrandName('Ëxämple (ácido fólico) 5 mg oral tablet')).toEqual({ name: 'Ëxämple', composition: 'Ácido Fólico', strength: '5 mg', dosageForm: 'Oral Tablet' });
    expect(parseBrandName('Rabipur (rabies vaccine) 2.5 IU/vial powder for injection')).toMatchObject({ strength: '2.5 IU/vial', dosageForm: 'Powder for Injection' });
  });

  it('drops a trailing supplier name from the dose form', () => {
    expect(parseBrandName('Paracetamol (paracetamol) 500 mg oral tablet Adcco Limited', 'Adcco Limited')).toEqual({ name: 'Paracetamol', composition: 'Paracetamol', strength: '500 mg', dosageForm: 'Oral Tablet' });
    expect(parseBrandName('Dolo (paracetamol) 650 mg oral tablet', 'Micro Labs Limited').dosageForm).toBe('Oral Tablet');
  });

  it('builds search and duplicate keys', () => {
    expect(searchKey('Dolo 650', 'Paracetamol')).toBe('dolo 650 paracetamol');
    expect(dedupeKey('Dolo  650', '650 mg', 'Oral Tablet')).toBe(dedupeKey('dolo 650', '650mg', 'oral  tablet'));
    expect(titleCase('salts and of water')).toBe('Salts and of Water');
    expect(splitTsv('1\tA\t\r')).toEqual(['1', 'A', '']);
  });
});

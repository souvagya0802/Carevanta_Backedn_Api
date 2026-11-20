/** Substitute key: same salt, same strength, same form family; tricky inputs; CDCI information builder. */
import { describe, expect, it } from 'vitest';
import { cdciInfo, compositionKey, doseFormFamily, infoSourceLine, keyParts, normaliseStrengthPart, substituteKey } from '../../src/modules/catalogue/medicine-info.js';

describe('compositionKey', () => {
  it('single ingredient: case, spaces and unit spelling do not matter', () => {
    const k = compositionKey('Paracetamol', '500 mg', 'Oral Tablet');
    expect(k).toBe('paracetamol|500mg|tablet');
    expect(compositionKey('  PARACETAMOL ', '500mg', 'oral   tablet')).toBe(k);
    expect(compositionKey('paracetamol', '0.5 g', 'Tablet')).toBe(k);
    expect(compositionKey('Paracetamol', '500 MG', 'Film-coated Oral Tablet')).toBe(k);
  });

  it('combinations are sorted with each strength kept on its ingredient', () => {
    const a = compositionKey('Caffeine and Paracetamol', '30 mg + 500 mg', 'Oral Tablet');
    const b = compositionKey('Paracetamol + Caffeine', '500 mg + 30 mg', 'Oral Tablet');
    const c = compositionKey('paracetamol, caffeine', '500mg+30mg', 'tablet');
    expect(a).toBe('caffeine+paracetamol|30mg+500mg|tablet');
    expect(b).toBe(a);
    expect(c).toBe(a);
    // Swapping the strengths is a different product.
    expect(compositionKey('Caffeine and Paracetamol', '500 mg + 30 mg', 'Oral Tablet')).not.toBe(a);
  });

  it('µg, μg, mcg and microgram are the same; micrograms compare with milligrams', () => {
    const k = compositionKey('Levothyroxine Sodium', '50 mcg', 'Oral Tablet');
    expect(compositionKey('Levothyroxine Sodium', '50 µg', 'Oral Tablet')).toBe(k);
    expect(compositionKey('Levothyroxine Sodium', '50 μg', 'Oral Tablet')).toBe(k);
    expect(compositionKey('Levothyroxine Sodium', '50 microgram', 'Oral Tablet')).toBe(k);
    expect(compositionKey('Levothyroxine Sodium', '0.05 mg', 'Oral Tablet')).toBe(k);
    expect(k).toBe('levothyroxine sodium|0.05mg|tablet');
  });

  it('dose form family: tablet ≠ syrup; release type, dispersible and route stay apart', () => {
    expect(compositionKey('Paracetamol', '500 mg', 'Oral Tablet')).not.toBe(compositionKey('Paracetamol', '500 mg', 'Oral Syrup'));
    expect(doseFormFamily('Prolonged-release Oral Tablet')).toBe('prolonged release tablet');
    expect(doseFormFamily('Extended Release Tablets')).toBe('prolonged release tablet');
    expect(doseFormFamily('Gastro-resistant Oral Tablet')).toBe('gastro resistant tablet');
    expect(doseFormFamily('Enteric coated tablet')).toBe('gastro resistant tablet');
    expect(doseFormFamily('Dispersible Oral Tablet')).toBe('dispersible tablet');
    expect(doseFormFamily('Hard Capsule')).toBe('capsule');
    expect(doseFormFamily('Eye Drops')).toBe('eye drops');
    expect(doseFormFamily('Oral Drops')).toBe('drops');
    expect(doseFormFamily('Oral Tablet Wings Pharmaceuticals Private Limited')).toBe('tablet');
    expect(doseFormFamily(null)).toBe('');
  });

  it('liquid and per-unit strengths: "/1 mL" = "/mL"; different denominators are kept exact', () => {
    expect(normaliseStrengthPart('50 mg/1 mL')).toBe('50mg/ml');
    expect(normaliseStrengthPart('50 mg/mL')).toBe('50mg/ml');
    expect(normaliseStrengthPart('125 mg/5 ml')).toBe('125mg/5ml');
    expect(normaliseStrengthPart('1 g/1 vial')).toBe('1000mg/vial');
    expect(normaliseStrengthPart('60 million unit')).toBe('60millionunit');
    expect(normaliseStrengthPart('1% w/w')).toBe('1%w/w');
    expect(compositionKey('Amoxicillin and Clavulanic Acid', '400 mg/5 ml + 57 mg/5 ml', 'Powder for Oral Suspension')).toBe('amoxicillin+clavulanic acid|400mg/5ml+57mg/5ml|powder for suspension');
  });

  it('no composition → no key; strength count mismatch keeps the strength text', () => {
    expect(compositionKey(null, '500 mg', 'Tablet')).toBeNull();
    expect(compositionKey('  ', '500 mg', 'Tablet')).toBeNull();
    expect(compositionKey('Paracetamol and Caffeine', '530 mg', 'Tablet')).toBe('caffeine+paracetamol|530mg|tablet');
    expect(keyParts('caffeine+paracetamol|30mg+500mg|tablet')).toEqual({ ingredients: 'caffeine+paracetamol', strength: '30mg+500mg', family: 'tablet' });
  });
});

describe('substituteKey', () => {
  it('uses genericName as the salt only for non-CDCI rows without a composition', () => {
    expect(substituteKey({ composition: null, genericName: 'Paracetamol', source: 'MANUAL', strength: '650 mg', dosageForm: 'Tablet' })).toBe('paracetamol|650mg|tablet');
    expect(substituteKey({ composition: null, genericName: 'Paracetamol 650 mg oral tablet', source: 'CDCI', strength: '650 mg', dosageForm: 'Tablet' })).toBeNull();
    expect(substituteKey({ composition: 'Caffeine and Paracetamol', genericName: 'X', source: 'MANUAL', strength: '30 mg + 500 mg', dosageForm: 'Tablet' })).toBe('caffeine+paracetamol|30mg+500mg|tablet');
  });
});

describe('cdciInfo', () => {
  const substances = new Map([
    ['1', { name: 'Paracetamol', description: 'Paracetamol reduces fever and pain.', toxicity: 'Liver damage in overdose.' }],
    ['3', { name: 'CAFFEINE', description: 'Caffeine is a stimulant.', toxicity: '' }],
  ]);
  it('single ingredient: plain text; empty generic → null', () => {
    const info = cdciInfo({ therapeuticRole: 'Analgesic', indication: 'Fever  and pain', contraIndication: '', interaction: '', substanceIds: ['1'] }, substances);
    expect(info).toEqual({ therapeuticClass: 'Analgesic', uses: 'Fever and pain', howItWorks: 'Paracetamol reduces fever and pain.', sideEffects: 'Liver damage in overdose.', contraindications: null, interactions: null });
    expect(cdciInfo({ therapeuticRole: '', indication: '', contraIndication: '', interaction: '', substanceIds: ['9'] }, substances)).toBeNull();
  });
  it('combination: one heading per ingredient that has text', () => {
    const info = cdciInfo({ therapeuticRole: '', indication: '', contraIndication: '', interaction: '', substanceIds: ['3', '1'] }, substances);
    expect(info?.howItWorks).toBe('Caffeine:\nCaffeine is a stimulant.\n\nParacetamol:\nParacetamol reduces fever and pain.');
    expect(info?.sideEffects).toBe('Paracetamol:\nLiver damage in overdose.');
  });
  it('source line', () => {
    expect(infoSourceLine('CDCI')).toBe('Information from CDCI, Government of India');
    expect(infoSourceLine('ADMIN')).toBe('Reviewed by Carevanta');
    expect(infoSourceLine(null)).toBeNull();
  });
});

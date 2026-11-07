import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, api } from '../helpers/factory.js';
import { affiliatedDoctor } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

const suggest = async (q: string) => {
  const res = await api().get(`/api/v1/discovery/suggest?q=${encodeURIComponent(q)}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};

describe('smart search', () => {
  it('understands everyday words, local words, typos and sentences, but shows doctors only after clinical approval', async () => {
    const { doctor } = await affiliatedDoctor({ specialities: ['GENERAL_MEDICINE'], departments: ['DEPT_GENERAL_MEDICINE'] });

    // Recognised, but no approved symptom → specialist link yet: no doctors, and we say why.
    const before = await suggest('bukhar');
    expect(before.understood).toMatchObject({ label: 'Fever', kind: 'condition', from: 'bukhar' });
    expect(before.specialities).toEqual([]);
    expect(before.doctors).toEqual([]);
    expect(before.awaitingReview).toContain('Fever');

    // A clinician approves Fever → General Medicine through the admin API (which also refreshes search).
    const reviewer = await actor(['CLINICAL_REVIEWER']);
    const fever = await prisma.condition.findUniqueOrThrow({ where: { slug: 'fever' } });
    const link = await prisma.conditionSpecialityMapping.findFirstOrThrow({ where: { conditionId: fever.id, speciality: { code: 'GENERAL_MEDICINE' } } });
    expect((await reviewer.post(`/api/v1/admin/catalogue/mappings/${link.id}/review`, { decision: 'APPROVED', note: 'Reviewed by clinician (synthetic)' })).status).toBe(200);

    for (const q of ['bukhar', 'fevr', 'My son has high fever since 2 days', 'JOR']) {
      const r = await suggest(q);
      expect(r.understood?.label, q).toBe('Fever');
      expect(r.specialities.map((s: { code: string }) => s.code), q).toContain('GENERAL_MEDICINE');
      expect(r.doctors.map((d: { id: string }) => d.id), q).toContain(doctor.id);
    }
    expect((await suggest('fevr')).understood.corrected).toBe(true);
  });

  it('red-flag symptoms put the emergency number first', async () => {
    const r = await suggest('snake bite');
    expect(r.emergency).toMatchObject({ number: expect.any(String) });
    expect(r.conditions[0].isRedFlag).toBe(true);
  });

  it('finds specialities, tests and medicines by the words people use', async () => {
    expect((await suggest('child doctor')).understood).toMatchObject({ label: 'Paediatrics', kind: 'speciality' });
    expect((await suggest('skin specialist')).understood.label).toBe('Dermatology');
    const sugar = await suggest('sugar test');
    expect(sugar.understood).toMatchObject({ label: 'Fasting blood sugar', kind: 'test' });
    expect(sugar.tests[0].code).toBe('LAB_FBS');
    // Half-typed words complete (cardiologist / cardiac) instead of being corrected into 'sardi' (a cold).
    const cardi = await suggest('cardi');
    expect(cardi.specialities.map((s: { code: string }) => s.code)).toContain('CARDIOLOGY');
    expect(cardi.understood.label).not.toBe('Cold and cough');
  });

  it('matches medicines and people by name with typos, and never suggests a medicine for a symptom', async () => {
    await prisma.medicine.create({ data: { name: 'Paracetamol', genericName: 'Paracetamol', strength: '500 mg', dosageForm: 'Tablet', packSize: '10', manufacturer: 'Synthetic Pharma', schedule: 'OTC', requiresPrescription: false } });
    const med = await suggest('paracitamol');
    expect(med.medicines.map((m: { name: string }) => m.name)).toContain('Paracetamol');
    expect((await suggest('fever')).medicines).toEqual([]);

    const named = await prisma.provider.findFirstOrThrow({ where: { type: 'DOCTOR', status: 'APPROVED' } });
    const firstWord = named.displayName.replace(/^Dr\.\s*/, '').split(' ')[0]!.toLowerCase();
    const byName = await suggest(`dr ${firstWord}`);
    expect(byName.doctors.some((d: { id: string; matchedByName: boolean }) => d.id === named.id && d.matchedByName)).toBe(true);
  });

  it('super-admin edits to everyday words take effect at once', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    expect((await suggest('asthi bishesoggo')).understood).toBeNull();
    const ortho = await prisma.speciality.findUniqueOrThrow({ where: { code: 'ORTHOPAEDICS' } });
    const res = await admin.patch(`/api/v1/admin/catalogue/specialities/${ortho.id}`, { synonyms: [...ortho.synonyms, 'Asthi Bishesoggo'] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.synonyms).toContain('asthi bishesoggo'); // stored lowercase
    expect((await suggest('asthi bishesoggo')).understood).toMatchObject({ label: 'Orthopaedics' });

    // Editing a test's words keeps its other fields; omitting synonyms leaves them alone.
    const fbs = await prisma.service.findUniqueOrThrow({ where: { code: 'LAB_FBS' } });
    expect((await admin.patch(`/api/v1/admin/catalogue/services/${fbs.id}`, { preparationInstructions: 'Fast for 8 to 10 hours.' })).status).toBe(200);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: fbs.id } })).synonyms).toEqual(fbs.synonyms);
  });

  it('public test catalogue looks tests up by exact code and by everyday name', async () => {
    const byCode = await api().get('/api/v1/public/catalogue/services?codes=LAB_URINE_RE,LAB_FBS');
    expect(byCode.body.data.map((x: { code: string }) => x.code).sort()).toEqual(['LAB_FBS', 'LAB_URINE_RE']);
    const byWord = await api().get('/api/v1/public/catalogue/services?q=sugar%20test');
    expect(byWord.body.data.map((x: { code: string }) => x.code)).toContain('LAB_FBS');
  });

  it('rejects junk input without errors', async () => {
    expect((await api().get('/api/v1/discovery/suggest?q=a')).status).toBe(400);
    const odd = await suggest("'; DROP TABLE providers; --");
    expect(odd.doctors).toEqual([]);
    expect((await suggest('zzzzqqqq')).understood).toBeNull();
  });
});

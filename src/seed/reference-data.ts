import type { PrismaClient } from '../../generated/prisma/client.js';
import { syncAccessControl } from '../modules/access/seed-access.js';

/**
 * Reference data required in every environment (including production).
 * Idempotent: rows are upserted by natural key; nothing is deleted.
 *
 * Clinical mappings are seeded as PENDING_REVIEW. Search uses only APPROVED
 * mappings, so a qualified clinical reviewer must approve each one in the admin
 * console before it influences patient-facing results.
 */

const REGIONS = [
  { code: 'WB-PMD-MOYNA', name: 'Moyna', district: 'Purba Medinipur', state: 'West Bengal', status: 'PILOT' as const },
  { code: 'WB-PMD-TAMLUK', name: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', status: 'PILOT' as const },
];

const SPECIALITIES: Array<{ code: string; name: string; parent?: string }> = [
  { code: 'GENERAL_MEDICINE', name: 'General Medicine' },
  { code: 'FAMILY_MEDICINE', name: 'Family Medicine' },
  { code: 'PAEDIATRICS', name: 'Paediatrics' },
  { code: 'OBSTETRICS_GYNAECOLOGY', name: 'Obstetrics & Gynaecology' },
  { code: 'GENERAL_SURGERY', name: 'General Surgery' },
  { code: 'ORTHOPAEDICS', name: 'Orthopaedics' },
  { code: 'CARDIOLOGY', name: 'Cardiology' },
  { code: 'GASTROENTEROLOGY', name: 'Gastroenterology' },
  { code: 'HEPATOLOGY', name: 'Hepatology', parent: 'GASTROENTEROLOGY' },
  { code: 'NEPHROLOGY', name: 'Nephrology' },
  { code: 'UROLOGY', name: 'Urology' },
  { code: 'NEUROLOGY', name: 'Neurology' },
  { code: 'PULMONOLOGY', name: 'Pulmonology' },
  { code: 'ENDOCRINOLOGY', name: 'Endocrinology' },
  { code: 'DERMATOLOGY', name: 'Dermatology' },
  { code: 'OPHTHALMOLOGY', name: 'Ophthalmology' },
  { code: 'ENT', name: 'ENT (Otorhinolaryngology)' },
  { code: 'PSYCHIATRY', name: 'Psychiatry' },
  { code: 'DENTISTRY', name: 'Dentistry' },
  { code: 'ONCOLOGY', name: 'Oncology' },
  { code: 'RADIOLOGY', name: 'Radiology' },
  { code: 'PATHOLOGY', name: 'Pathology' },
  { code: 'EMERGENCY_MEDICINE', name: 'Emergency Medicine' },
  { code: 'PHYSIOTHERAPY', name: 'Physiotherapy' },
];

const CONDITIONS: Array<{ name: string; kind?: 'CONDITION' | 'SYMPTOM'; synonyms?: string[]; redFlag?: boolean; map: Array<[string, 'PRIMARY' | 'SECONDARY']> }> = [
  { name: 'Liver disease', synonyms: ['fatty liver', 'hepatitis', 'jaundice', 'liver problem'], map: [['HEPATOLOGY', 'PRIMARY'], ['GASTROENTEROLOGY', 'PRIMARY']] },
  { name: 'Kidney stones', synonyms: ['renal stone', 'stone in kidney'], map: [['UROLOGY', 'PRIMARY'], ['NEPHROLOGY', 'SECONDARY']] },
  { name: 'Chronic kidney disease', synonyms: ['CKD', 'kidney failure'], map: [['NEPHROLOGY', 'PRIMARY']] },
  { name: 'Diabetes', synonyms: ['sugar', 'high blood sugar', 'diabetes mellitus'], map: [['ENDOCRINOLOGY', 'PRIMARY'], ['GENERAL_MEDICINE', 'SECONDARY']] },
  { name: 'High blood pressure', synonyms: ['hypertension', 'BP'], map: [['GENERAL_MEDICINE', 'PRIMARY'], ['CARDIOLOGY', 'SECONDARY']] },
  { name: 'Heart disease', synonyms: ['heart problem', 'cardiac'], map: [['CARDIOLOGY', 'PRIMARY']] },
  { name: 'Eye infection', synonyms: ['red eye', 'conjunctivitis', 'eye problem'], map: [['OPHTHALMOLOGY', 'PRIMARY']] },
  { name: 'Skin allergy', synonyms: ['rash', 'itching', 'eczema'], map: [['DERMATOLOGY', 'PRIMARY']] },
  { name: 'Joint pain', kind: 'SYMPTOM', synonyms: ['arthritis', 'knee pain', 'back pain'], map: [['ORTHOPAEDICS', 'PRIMARY'], ['GENERAL_MEDICINE', 'SECONDARY']] },
  { name: 'Tooth pain', kind: 'SYMPTOM', synonyms: ['dental pain', 'toothache'], map: [['DENTISTRY', 'PRIMARY']] },
  { name: 'Pregnancy care', synonyms: ['antenatal', 'pregnant'], map: [['OBSTETRICS_GYNAECOLOGY', 'PRIMARY']] },
  { name: 'Fever', kind: 'SYMPTOM', synonyms: ['high temperature', 'jor'], map: [['GENERAL_MEDICINE', 'PRIMARY'], ['PAEDIATRICS', 'SECONDARY']] },
  { name: 'Child cough', kind: 'SYMPTOM', synonyms: ['cough in child'], map: [['PAEDIATRICS', 'PRIMARY']] },
  { name: 'Asthma', synonyms: ['breathing problem', 'wheezing'], map: [['PULMONOLOGY', 'PRIMARY']] },
  { name: 'Thyroid disorder', synonyms: ['thyroid', 'hypothyroidism', 'hyperthyroidism'], map: [['ENDOCRINOLOGY', 'PRIMARY']] },
  { name: 'Ear pain', kind: 'SYMPTOM', synonyms: ['ear infection'], map: [['ENT', 'PRIMARY']] },
  { name: 'Depression and anxiety', synonyms: ['mental health', 'stress'], map: [['PSYCHIATRY', 'PRIMARY']] },
  // Red-flag symptoms: patient apps must show emergency guidance (112) first.
  { name: 'Chest pain', kind: 'SYMPTOM', redFlag: true, synonyms: ['pain in chest'], map: [['EMERGENCY_MEDICINE', 'PRIMARY'], ['CARDIOLOGY', 'SECONDARY']] },
  { name: 'Difficulty breathing', kind: 'SYMPTOM', redFlag: true, synonyms: ['shortness of breath', 'breathlessness'], map: [['EMERGENCY_MEDICINE', 'PRIMARY'], ['PULMONOLOGY', 'SECONDARY']] },
  { name: 'Stroke symptoms', kind: 'SYMPTOM', redFlag: true, synonyms: ['face drooping', 'sudden weakness', 'slurred speech'], map: [['EMERGENCY_MEDICINE', 'PRIMARY'], ['NEUROLOGY', 'SECONDARY']] },
];

const DEPARTMENTS: Array<[string, string, string | null]> = [
  ['DEPT_GENERAL_MEDICINE', 'General Medicine', 'GENERAL_MEDICINE'],
  ['DEPT_PAEDIATRICS', 'Paediatrics', 'PAEDIATRICS'],
  ['DEPT_OBGYN', 'Obstetrics & Gynaecology', 'OBSTETRICS_GYNAECOLOGY'],
  ['DEPT_SURGERY', 'General Surgery', 'GENERAL_SURGERY'],
  ['DEPT_ORTHO', 'Orthopaedics', 'ORTHOPAEDICS'],
  ['DEPT_CARDIO', 'Cardiology', 'CARDIOLOGY'],
  ['DEPT_GASTRO', 'Gastroenterology', 'GASTROENTEROLOGY'],
  ['DEPT_UROLOGY', 'Urology', 'UROLOGY'],
  ['DEPT_NEPHRO', 'Nephrology', 'NEPHROLOGY'],
  ['DEPT_EYE', 'Ophthalmology', 'OPHTHALMOLOGY'],
  ['DEPT_ENT', 'ENT', 'ENT'],
  ['DEPT_EMERGENCY', 'Emergency', 'EMERGENCY_MEDICINE'],
  ['DEPT_RADIOLOGY', 'Radiology', 'RADIOLOGY'],
  ['DEPT_PATHOLOGY', 'Pathology / Laboratory', 'PATHOLOGY'],
];

const AMENITIES: Array<[string, string, string]> = [
  ['ICU', 'Intensive care unit', 'CLINICAL'],
  ['NICU', 'Neonatal ICU', 'CLINICAL'],
  ['OT', 'Operation theatre', 'CLINICAL'],
  ['BLOOD_BANK', 'Blood bank', 'CLINICAL'],
  ['EMERGENCY_24X7', '24×7 emergency', 'CLINICAL'],
  ['XRAY', 'X-ray', 'IMAGING'],
  ['USG', 'Ultrasound', 'IMAGING'],
  ['CT', 'CT scanner', 'IMAGING'],
  ['MRI', 'MRI scanner', 'IMAGING'],
  ['IN_HOUSE_PHARMACY', 'In-house pharmacy', 'SUPPORT'],
  ['IN_HOUSE_LAB', 'In-house laboratory', 'SUPPORT'],
  ['AMBULANCE', 'Ambulance service', 'SUPPORT'],
  ['WHEELCHAIR_ACCESS', 'Wheelchair access', 'ACCESSIBILITY'],
  ['PARKING', 'Parking', 'FACILITY'],
];

const SERVICES: Array<{ code: string; name: string; category: 'CONSULTATION' | 'DIAGNOSTIC_TEST' | 'IMAGING' | 'PROCEDURE'; speciality?: string; sampleType?: string; fasting?: boolean; prep?: string; rx?: boolean }> = [
  { code: 'CONSULT_OPD', name: 'Outpatient consultation', category: 'CONSULTATION' },
  { code: 'LAB_CBC', name: 'Complete blood count (CBC)', category: 'DIAGNOSTIC_TEST', speciality: 'PATHOLOGY', sampleType: 'BLOOD', fasting: false },
  { code: 'LAB_LFT', name: 'Liver function test (LFT)', category: 'DIAGNOSTIC_TEST', speciality: 'PATHOLOGY', sampleType: 'BLOOD', fasting: false },
  { code: 'LAB_KFT', name: 'Kidney function test (KFT)', category: 'DIAGNOSTIC_TEST', speciality: 'PATHOLOGY', sampleType: 'BLOOD', fasting: false },
  { code: 'LAB_FBS', name: 'Fasting blood sugar', category: 'DIAGNOSTIC_TEST', speciality: 'PATHOLOGY', sampleType: 'BLOOD', fasting: true, prep: 'Provider-supplied fasting instructions must be shown before booking.' },
  { code: 'LAB_LIPID', name: 'Lipid profile', category: 'DIAGNOSTIC_TEST', speciality: 'PATHOLOGY', sampleType: 'BLOOD', fasting: true, prep: 'Provider-supplied fasting instructions must be shown before booking.' },
  { code: 'LAB_THYROID', name: 'Thyroid profile (T3, T4, TSH)', category: 'DIAGNOSTIC_TEST', speciality: 'PATHOLOGY', sampleType: 'BLOOD', fasting: false },
  { code: 'LAB_URINE_RE', name: 'Urine routine examination', category: 'DIAGNOSTIC_TEST', speciality: 'PATHOLOGY', sampleType: 'URINE', fasting: false },
  { code: 'IMG_XRAY_CHEST', name: 'X-ray chest PA view', category: 'IMAGING', speciality: 'RADIOLOGY', rx: true },
  { code: 'IMG_USG_ABDOMEN', name: 'Ultrasound whole abdomen', category: 'IMAGING', speciality: 'RADIOLOGY', rx: true },
  { code: 'IMG_CT_HEAD', name: 'CT scan head (plain)', category: 'IMAGING', speciality: 'RADIOLOGY', rx: true },
  { code: 'PROC_ECG', name: 'Electrocardiogram (ECG)', category: 'PROCEDURE', speciality: 'CARDIOLOGY' },
];

const TEMPLATES: Array<{ key: string; channel: 'EMAIL' | 'SMS'; subject?: string; body: string }> = [
  { key: 'auth.password_reset', channel: 'EMAIL', subject: 'Reset your Carevanta password', body: 'Use this code to reset your password: {{token}}. It expires in {{expiresInMinutes}} minutes. If you did not request this, ignore this message.' },
  { key: 'auth.password_reset', channel: 'SMS', body: 'Carevanta password reset code: {{token}} (valid {{expiresInMinutes}} min). Do not share it.' },
  { key: 'auth.verify_email', channel: 'EMAIL', subject: 'Verify your email for Carevanta', body: 'Your verification code is {{token}}.' },
  { key: 'auth.verify_phone', channel: 'SMS', body: 'Your Carevanta verification code is {{token}}. It expires in 10 minutes.' },
  { key: 'auth.account_created', channel: 'EMAIL', subject: 'Your Carevanta account', body: 'An administrator created a Carevanta account for you. Use the password reset code {{token}} to set your password.' },
  { key: 'auth.account_created', channel: 'SMS', body: 'Carevanta: an account was created for you. Set your password with code {{token}} (valid 72 h).' },
  { key: 'booking.confirmed', channel: 'SMS', body: 'Carevanta: appointment {{reference}} is confirmed for {{when}}.' },
  { key: 'booking.cancelled', channel: 'SMS', body: 'Carevanta: appointment {{reference}} was cancelled.' },
  { key: 'provider.status_changed', channel: 'EMAIL', subject: 'Your Carevanta provider application', body: 'Your provider application status is now {{status}}.' },
];

const SETTINGS: Array<{ key: string; value: unknown; description: string }> = [
  { key: 'booking.patient_cancellation_cutoff_minutes', value: 120, description: 'Patients may cancel without penalty until this many minutes before the slot.' },
  { key: 'booking.require_provider_confirmation', value: true, description: 'Appointments start as REQUESTED and need provider confirmation.' },
  { key: 'finance.settlement_hold_days', value: 7, description: 'Days after service completion before earnings become settleable.' },
  { key: 'finance.commission_on_provider_direct', value: false, description: 'Charge commission on PROVIDER_DIRECT (walk-in) bookings. Default off.' },
  { key: 'emergency.public_number', value: '112', description: 'National emergency number shown first on every emergency screen.' },
  { key: 'emergency.live_dispatch_enabled', value: false, description: 'Live ambulance dispatch through partner operators. Off until operationally validated.' },
  { key: 'search.default_radius_km', value: 15, description: 'Default provider search radius.' },
];

export async function seedReferenceData(db: PrismaClient): Promise<void> {
  await syncAccessControl(db);

  for (const r of REGIONS) {
    await db.serviceRegion.upsert({ where: { code: r.code }, create: r, update: { name: r.name, district: r.district, state: r.state } });
  }

  for (const s of SPECIALITIES.filter((x) => !x.parent)) {
    await db.speciality.upsert({ where: { code: s.code }, create: { code: s.code, name: s.name }, update: { name: s.name } });
  }
  for (const s of SPECIALITIES.filter((x) => x.parent)) {
    const parent = await db.speciality.findUniqueOrThrow({ where: { code: s.parent! } });
    await db.speciality.upsert({
      where: { code: s.code },
      create: { code: s.code, name: s.name, parentId: parent.id },
      update: { name: s.name, parentId: parent.id },
    });
  }
  const specByCode = new Map((await db.speciality.findMany()).map((s) => [s.code, s.id]));

  for (const c of CONDITIONS) {
    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const cond = await db.condition.upsert({
      where: { slug },
      create: { name: c.name, slug, kind: c.kind ?? 'CONDITION', synonyms: c.synonyms ?? [], isRedFlag: c.redFlag ?? false },
      update: { synonyms: c.synonyms ?? [], isRedFlag: c.redFlag ?? false, kind: c.kind ?? 'CONDITION' },
    });
    for (const [code, relevance] of c.map) {
      const specialityId = specByCode.get(code)!;
      await db.conditionSpecialityMapping.upsert({
        where: { conditionId_specialityId: { conditionId: cond.id, specialityId } },
        create: {
          conditionId: cond.id,
          specialityId,
          relevance,
          reviewStatus: 'PENDING_REVIEW',
          rationale: 'Seeded starter mapping — requires clinical review before use in search.',
        },
        update: {}, // never overwrite a reviewer's decision
      });
    }
  }

  for (const [code, name, spec] of DEPARTMENTS) {
    await db.department.upsert({
      where: { code },
      create: { code, name, specialityId: spec ? specByCode.get(spec) ?? null : null },
      update: { name },
    });
  }
  for (const [code, name, category] of AMENITIES) {
    await db.amenity.upsert({ where: { code }, create: { code, name, category }, update: { name, category } });
  }
  for (const s of SERVICES) {
    const data = {
      name: s.name,
      category: s.category,
      specialityId: s.speciality ? specByCode.get(s.speciality) ?? null : null,
      sampleType: s.sampleType ?? null,
      fastingRequired: s.fasting ?? null,
      preparationInstructions: s.prep ?? null,
      requiresPrescription: s.rx ?? false,
    };
    await db.service.upsert({ where: { code: s.code }, create: { code: s.code, ...data }, update: data });
  }

  for (const t of TEMPLATES) {
    const existing = await db.notificationTemplate.findFirst({ where: { key: t.key, channel: t.channel, locale: 'en' } });
    if (!existing) {
      await db.notificationTemplate.create({ data: { key: t.key, channel: t.channel, locale: 'en', subject: t.subject ?? null, body: t.body } });
    }
  }

  for (const s of SETTINGS) {
    await db.platformSetting.upsert({
      where: { key: s.key },
      create: { key: s.key, value: s.value as object, description: s.description },
      update: { description: s.description }, // keep operator-changed values
    });
  }
}

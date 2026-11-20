import type { PrismaClient } from '../../generated/prisma/client.js';
import { syncAccessControl } from '../modules/access/seed-access.js';
import { CONDITION_TERMS, EXTRA_CONDITIONS, SERVICE_TERMS, SPECIALITY_TERMS, mergeTerms } from './search-vocabulary.js';

/**
 * Reference data required in every environment (including production).
 * Idempotent: rows are upserted by natural key; nothing is deleted.
 *
 * Clinical mappings are seeded as PENDING_REVIEW. Search uses only APPROVED
 * mappings, so a qualified clinical reviewer must approve each one in the admin
 * console before it influences patient-facing results.
 */

// No service regions are seeded: geography is data, created by a super-admin in
// Settings → Service Regions on each environment.

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
  { code: 'LAB_FBS', name: 'Fasting blood sugar', category: 'DIAGNOSTIC_TEST', speciality: 'PATHOLOGY', sampleType: 'BLOOD', fasting: true, prep: 'Do not eat or drink anything except plain water for 10 to 12 hours before the test. Take regular medicines only if your doctor says so.' },
  { code: 'LAB_LIPID', name: 'Lipid profile', category: 'DIAGNOSTIC_TEST', speciality: 'PATHOLOGY', sampleType: 'BLOOD', fasting: true, prep: 'Do not eat or drink anything except plain water for 10 to 12 hours before the test. Take regular medicines only if your doctor says so.' },
  { code: 'LAB_THYROID', name: 'Thyroid profile (T3, T4, TSH)', category: 'DIAGNOSTIC_TEST', speciality: 'PATHOLOGY', sampleType: 'BLOOD', fasting: false },
  { code: 'LAB_URINE_RE', name: 'Urine routine examination', category: 'DIAGNOSTIC_TEST', speciality: 'PATHOLOGY', sampleType: 'URINE', fasting: false },
  { code: 'IMG_XRAY_CHEST', name: 'X-ray chest PA view', category: 'IMAGING', speciality: 'RADIOLOGY', rx: true },
  { code: 'IMG_USG_ABDOMEN', name: 'Ultrasound whole abdomen', category: 'IMAGING', speciality: 'RADIOLOGY', rx: true },
  { code: 'IMG_CT_HEAD', name: 'CT scan head (plain)', category: 'IMAGING', speciality: 'RADIOLOGY', rx: true },
  { code: 'PROC_ECG', name: 'Electrocardiogram (ECG)', category: 'PROCEDURE', speciality: 'CARDIOLOGY' },
  { code: 'IMG_MRI_BRAIN', name: 'MRI brain (plain)', category: 'IMAGING', speciality: 'RADIOLOGY', rx: true, prep: 'Remove all metal (jewellery, hair clips). Tell the centre about any implant or pacemaker.' },
  { code: 'IMG_XRAY_KNEE', name: 'X-ray knee (AP and lateral)', category: 'IMAGING', speciality: 'RADIOLOGY' },
  { code: 'IMG_USG_PELVIS', name: 'Ultrasound pelvis', category: 'IMAGING', speciality: 'RADIOLOGY', prep: 'Drink 4 to 5 glasses of water an hour before and do not pass urine.' },
  { code: 'PROC_ECHO', name: 'Echocardiography (2D Echo)', category: 'PROCEDURE', speciality: 'CARDIOLOGY' },
];

/**
 * Default email layout: one centred card, inline styles only (email clients
 * ignore stylesheets), no images, no region-specific content. The delivery
 * driver derives the plain-text part from this HTML automatically.
 */
function emailHtml(heading: string, paragraphs: string[], highlight?: string): string {
  const p = (t: string) => `<p style="margin:0 0 12px;font:15px/1.6 Arial,Helvetica,sans-serif;color:#1f2937">${t}</p>`;
  const code = highlight ? `<p style="margin:16px 0;padding:12px 16px;background:#f3f4f6;border-radius:5px;font:600 22px/1.3 'Courier New',monospace;letter-spacing:2px;color:#111827;text-align:center">${highlight}</p>` : '';
  return [
    '<div style="background:#f3f4f6;padding:24px 12px">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:5px;overflow:hidden">',
    '<div style="background:#111111;padding:16px 24px;font:700 18px/1.3 Arial,Helvetica,sans-serif;color:#ffffff">Carevanta</div>',
    `<div style="padding:24px"><h1 style="margin:0 0 16px;font:700 20px/1.3 Arial,Helvetica,sans-serif;color:#111827">${heading}</h1>${paragraphs.map(p).join('')}${code}</div>`,
    '<div style="padding:12px 24px 20px;font:12px/1.5 Arial,Helvetica,sans-serif;color:#6b7280">This is an automated message from Carevanta. Please do not reply to it.</div>',
    '</div></div>',
  ].join('');
}

/** One default per (key, channel) in the notification catalogue; English, active, inserted only when nothing exists for that pair yet. */
const TEMPLATES: Array<{ key: string; channel: 'EMAIL' | 'SMS' | 'PUSH' | 'IN_APP'; subject?: string; body: string }> = [
  { key: 'auth.password_reset', channel: 'EMAIL', subject: 'Reset your Carevanta password', body: emailHtml('Reset your password', ['Use the code below to reset your Carevanta password. It expires in {{expiresInMinutes}} minutes.', 'If you did not request this, you can safely ignore this email.'], '{{token}}') },
  { key: 'auth.password_reset', channel: 'SMS', body: 'Carevanta password reset code: {{token}} (valid {{expiresInMinutes}} min). Do not share it.' },
  { key: 'auth.verify_email', channel: 'EMAIL', subject: 'Verify your email for Carevanta', body: emailHtml('Verify your email address', ['Enter this code in the app to confirm your email address.'], '{{token}}') },
  { key: 'auth.verify_phone', channel: 'SMS', body: 'Your Carevanta verification code is {{token}}. It expires in 10 minutes.' },
  { key: 'auth.account_created', channel: 'EMAIL', subject: 'Your Carevanta account is ready', body: emailHtml('Welcome to Carevanta', ['An administrator created a Carevanta account for you. Use the one-time code below to set your password. It is valid for 72 hours.'], '{{token}}') },
  { key: 'auth.account_created', channel: 'SMS', body: 'Carevanta: an account was created for you. Set your password with code {{token}} (valid 72 h).' },
  { key: 'booking.confirmed', channel: 'SMS', body: 'Carevanta: appointment {{reference}} is confirmed for {{when}}.' },
  { key: 'booking.cancelled', channel: 'SMS', body: 'Carevanta: appointment {{reference}} was cancelled.' },
  { key: 'booking.confirmed', channel: 'EMAIL', subject: 'Appointment {{reference}} confirmed for {{when}}', body: emailHtml('Your appointment is confirmed', ['Your appointment <strong>{{reference}}</strong> with {{doctorName}} is confirmed.', 'When: <strong>{{when}}</strong>', 'Please arrive a few minutes early and bring any previous reports or prescriptions.']) },
  { key: 'booking.cancelled', channel: 'EMAIL', subject: 'Appointment {{reference}} cancelled', body: emailHtml('Your appointment was cancelled', ['Appointment <strong>{{reference}}</strong> with {{doctorName}} on {{when}} was cancelled.', 'Any payment you made will be refunded. Open the app to book another slot.']) },
  { key: 'provider.status_changed', channel: 'EMAIL', subject: 'Your Carevanta provider application: {{status}}', body: emailHtml('Application update', ['The status of your provider application is now <strong>{{status}}</strong>.', 'Sign in to the provider portal to see the details and any next steps.']) },
  { key: 'booking.reminder', channel: 'EMAIL', subject: 'Reminder: appointment {{reference}} on {{when}}', body: emailHtml('Your appointment is coming up', ['Hello {{patientName}}, this is a reminder that your appointment <strong>{{reference}}</strong> with {{doctorName}} at {{locationName}} is in about {{hoursBefore}} hours.', 'When: <strong>{{when}}</strong>', 'Please arrive a few minutes early and bring any previous reports or prescriptions.']) },
  { key: 'booking.reminder', channel: 'PUSH', subject: 'Appointment in {{hoursBefore}} hours', body: '{{reference}} with {{doctorName}} at {{locationName}}, {{when}}.' },
  { key: 'booking.reminder', channel: 'IN_APP', subject: 'Appointment reminder', body: 'Your appointment {{reference}} with {{doctorName}} at {{locationName}} is on {{when}} (in about {{hoursBefore}} hours).' },
  { key: 'booking.requested', channel: 'EMAIL', subject: 'New appointment request {{reference}}', body: emailHtml('New appointment request', ['{{patientName}} has requested an appointment <strong>{{reference}}</strong> with {{doctorName}}.', 'Requested slot: <strong>{{when}}</strong>', 'Open the provider portal to confirm or propose another time.']) },
  { key: 'booking.requested', channel: 'IN_APP', subject: 'New appointment request', body: '{{patientName}} requested {{reference}} with {{doctorName}} for {{when}}.' },
  { key: 'booking.rescheduled', channel: 'EMAIL', subject: 'Appointment {{reference}} moved to {{when}}', body: emailHtml('Your appointment was rescheduled', ['Appointment <strong>{{reference}}</strong> with {{doctorName}} now takes place on <strong>{{when}}</strong>.', 'If the new time does not suit you, open the app to pick another slot.']) },
  { key: 'booking.rescheduled', channel: 'IN_APP', subject: 'Appointment rescheduled', body: '{{reference}} with {{doctorName}} is now on {{when}}.' },
  { key: 'order.status_changed', channel: 'EMAIL', subject: '{{kind}} order {{reference}}: {{status}}', body: emailHtml('Order update', ['Your {{kind}} order <strong>{{reference}}</strong> is now: <strong>{{status}}</strong>.', 'Open the app to see the full order and any reports attached to it.']) },
  { key: 'order.status_changed', channel: 'IN_APP', subject: '{{kind}} order {{status}}', body: 'Order {{reference}} is now {{status}}.' },
  { key: 'dispatch.status_changed', channel: 'EMAIL', subject: 'Emergency request {{reference}}: {{status}}', body: emailHtml('Emergency request update', ['Your emergency request <strong>{{reference}}</strong> is now: <strong>{{status}}</strong>.', 'Follow it live in the app. If the situation worsens, call your national emergency number at once.']) },
  { key: 'dispatch.status_changed', channel: 'IN_APP', subject: 'Emergency request {{status}}', body: 'Emergency request {{reference}} is now {{status}}.' },
  { key: 'support.reply', channel: 'EMAIL', subject: 'Reply on your support case {{caseReference}}', body: emailHtml('Support has replied', ['There is a new reply on your support case <strong>{{caseReference}}</strong>.', 'Open the app to read it and continue the conversation. Please do not reply to this email.']) },
  { key: 'support.reply', channel: 'IN_APP', subject: 'Support replied', body: 'New reply on your case {{caseReference}}.' },
  { key: 'catalogue.medicines_synced', channel: 'EMAIL', subject: 'Medicine list sync: {{status}}', body: emailHtml('Medicine list sync', ['{{summary}}', 'CDCI release date: <strong>{{releaseDate}}</strong>', 'Open the Catalogue page in the admin dashboard to review the medicines. Medicine names from Common Drug Codes for India (CDCI), C-DAC / NRCeS, MoHFW, CC BY 4.0.']) },
  { key: 'catalogue.medicines_synced', channel: 'IN_APP', subject: 'Medicine list sync: {{status}}', body: '{{summary}}' },
];

const SETTINGS: Array<{ key: string; value: unknown; description: string }> = [
  { key: 'booking.patient_cancellation_cutoff_minutes', value: 120, description: 'Patients may cancel without penalty until this many minutes before the slot.' },
  { key: 'booking.require_provider_confirmation', value: true, description: 'Appointments start as REQUESTED and need provider confirmation.' },
  { key: 'booking.reminders_enabled', value: true, description: 'Send patients a reminder (in-app, push, email) before each confirmed booking.' },
  { key: 'booking.reminder_lead_hours', value: '24,2', description: 'Hours before a booking at which reminders go out, comma-separated (largest first).' },
  { key: 'catalogue.cdci_sync_enabled', value: true, description: 'Check monthly for a new CDCI medicine list release and apply it after validation.' },
  { key: 'catalogue.cdci_source_base_url', value: 'https://raw.githubusercontent.com/ohcnetwork/cdci/main/data/source', description: 'Folder the CDCI flat files are downloaded from (CC BY 4.0 mirror by default).' },
  { key: 'finance.settlement_hold_days', value: 7, description: 'Days after service completion before earnings become settleable.' },
  { key: 'finance.commission_on_provider_direct', value: false, description: 'Charge commission on PROVIDER_DIRECT (walk-in) bookings. Default off.' },
  { key: 'invoice.seller_legal_name', value: 'Carevanta', description: 'Platform legal name printed on invoices.' },
  { key: 'invoice.seller_address', value: '', description: 'Platform registered address printed on invoices.' },
  { key: 'invoice.seller_gstin', value: '', description: 'Platform GSTIN printed on invoices (blank until registered).' },
  { key: 'invoice.seller_pan', value: '', description: 'Platform PAN printed on invoices.' },
  { key: 'invoice.seller_state_code', value: '', description: 'GST state code of the platform.' },
  { key: 'invoice.number_prefix', value: 'CV', description: 'Prefix of invoice numbers (CV-INV-2026-27-000001).' },
  { key: 'invoice.commission_gst_percent', value: 18, description: 'GST percent charged on platform commission (confirm with CA).' },
  { key: 'invoice.footer_note', value: '', description: 'Footer line printed on every invoice.' },
  { key: 'invoice.show_provider_gstin', value: true, description: 'Print the provider GSTIN on patient invoices when on record.' },
  { key: 'emergency.public_number', value: '112', description: 'National emergency number shown first on every emergency screen.' },
  { key: 'emergency.live_dispatch_enabled', value: false, description: 'Live ambulance dispatch through partner operators. Off until operationally validated.' },
  { key: 'search.default_radius_km', value: 15, description: 'Default provider search radius.' },
  { key: 'portal.ui', value: {}, description: 'Provider portal structure and copy overrides (section names, page copy, hidden pages, banner, support contacts). Empty = as shipped.' },
  { key: 'portal.member_capabilities', value: {}, description: 'Provider staff role → capability overrides. Empty = as shipped; owners always hold everything.' },
  { key: 'patient.ui', value: {}, description: 'Patient app content overrides (hero, landing, categories, banner, support, theme). Empty = as shipped.' },
];

export async function seedReferenceData(db: PrismaClient): Promise<void> {
  await syncAccessControl(db);

  for (const s of SPECIALITIES.filter((x) => !x.parent)) {
    await db.speciality.upsert({ where: { code: s.code }, create: { code: s.code, name: s.name }, update: {} }); // insert only: admin renames survive a re-seed
  }
  for (const s of SPECIALITIES.filter((x) => x.parent)) {
    const parent = await db.speciality.findUniqueOrThrow({ where: { code: s.parent! } });
    await db.speciality.upsert({
      where: { code: s.code },
      create: { code: s.code, name: s.name, parentId: parent.id },
      update: {}, // insert only: admin edits survive a re-seed
    });
  }
  for (const sp of await db.speciality.findMany({ select: { id: true, code: true, synonyms: true } })) {
    const merged = mergeTerms(sp.synonyms, SPECIALITY_TERMS[sp.code]);
    if (merged.length !== sp.synonyms.length) await db.speciality.update({ where: { id: sp.id }, data: { synonyms: merged } });
  }
  const specByCode = new Map((await db.speciality.findMany()).map((s) => [s.code, s.id]));

  for (const c of [...CONDITIONS, ...EXTRA_CONDITIONS]) {
    const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const cond = await db.condition.upsert({
      where: { slug },
      create: { name: c.name, slug, kind: c.kind ?? 'CONDITION', synonyms: mergeTerms(c.synonyms ?? [], CONDITION_TERMS[c.name]), isRedFlag: c.redFlag ?? false },
      update: { isRedFlag: c.redFlag ?? false, kind: c.kind ?? 'CONDITION' },
    });
    // Merge so words an admin added in the dashboard survive a re-seed.
    const merged = mergeTerms(cond.synonyms, [...(c.synonyms ?? []), ...(CONDITION_TERMS[c.name] ?? [])]);
    if (merged.length !== cond.synonyms.length) await db.condition.update({ where: { id: cond.id }, data: { synonyms: merged } });
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
      update: {}, // insert only: admin edits survive a re-seed
    });
  }
  // Amenities created before the active flag existed have no is_active field; mark them active.
  await db.$runCommandRaw({ update: 'amenities', updates: [{ q: { is_active: { $exists: false } }, u: { $set: { is_active: true } }, multi: true }] });
  for (const [code, name, category] of AMENITIES) {
    await db.amenity.upsert({ where: { code }, create: { code, name, category }, update: {} }); // insert only: admin edits survive a re-seed
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
    const svc = await db.service.upsert({ where: { code: s.code }, create: { code: s.code, ...data, synonyms: mergeTerms([], SERVICE_TERMS[s.code]) }, update: {} }); // insert only: admin edits survive a re-seed
    const merged = mergeTerms(svc.synonyms, SERVICE_TERMS[s.code]);
    if (merged.length !== svc.synonyms.length) await db.service.update({ where: { id: svc.id }, data: { synonyms: merged } });
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

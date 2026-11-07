/**
 * Everyday words patients actually type, so search understands "bukhar",
 * "child doctor" or "sugar test" and not only textbook names.
 *
 * Local words are written in Latin script the way people type them on a phone
 * (Bengali and Hindi). All terms are lowercase. The seed MERGES these into the
 * catalogue, so anything an admin added in the dashboard is kept.
 *
 * Symptom → speciality links added here are starter suggestions only: they are
 * created as PENDING_REVIEW and search ignores them until a clinician approves
 * them in Catalogue → Mappings.
 */

export const SPECIALITY_TERMS: Record<string, string[]> = {
  GENERAL_MEDICINE: ['general physician', 'physician', 'gp', 'general doctor', 'medicine doctor', 'md medicine'],
  FAMILY_MEDICINE: ['family doctor', 'family physician'],
  PAEDIATRICS: ['child doctor', 'child specialist', 'baby doctor', 'kids doctor', 'paediatrician', 'pediatrician', 'pediatrics', 'shishu doctor', 'shishu bishesoggo', 'bacchon ka doctor'],
  OBSTETRICS_GYNAECOLOGY: ['gynaecologist', 'gynecologist', 'gyno', 'lady doctor', 'women doctor', 'pregnancy doctor', 'obstetrician', 'stri rog'],
  GENERAL_SURGERY: ['surgeon', 'general surgeon', 'operation doctor'],
  ORTHOPAEDICS: ['bone doctor', 'bone specialist', 'orthopaedic', 'orthopedic', 'ortho', 'joint doctor', 'haddi doctor', 'harer doctor'],
  CARDIOLOGY: ['heart doctor', 'heart specialist', 'cardiologist', 'cardiac doctor'],
  GASTROENTEROLOGY: ['gastroenterologist', 'stomach doctor', 'gastro', 'pet doctor', 'digestive specialist'],
  HEPATOLOGY: ['liver doctor', 'liver specialist', 'hepatologist'],
  NEPHROLOGY: ['kidney doctor', 'kidney specialist', 'nephrologist'],
  UROLOGY: ['urologist', 'urine doctor', 'prostate doctor'],
  NEUROLOGY: ['neurologist', 'nerve doctor', 'brain doctor', 'nerve specialist'],
  PULMONOLOGY: ['chest doctor', 'lung doctor', 'chest specialist', 'pulmonologist', 'chest physician'],
  ENDOCRINOLOGY: ['hormone doctor', 'sugar doctor', 'diabetes doctor', 'thyroid doctor', 'endocrinologist', 'diabetologist'],
  DERMATOLOGY: ['skin doctor', 'skin specialist', 'dermatologist', 'hair doctor', 'chormo rog'],
  OPHTHALMOLOGY: ['eye doctor', 'eye specialist', 'ophthalmologist', 'chokher doctor', 'aankh doctor'],
  ENT: ['ent doctor', 'ear nose throat', 'ear doctor', 'nose doctor', 'throat doctor'],
  PSYCHIATRY: ['psychiatrist', 'mental health doctor', 'mind doctor'],
  DENTISTRY: ['dentist', 'teeth doctor', 'tooth doctor', 'dental', 'danter doctor', 'daant doctor'],
  ONCOLOGY: ['cancer doctor', 'cancer specialist', 'oncologist'],
  RADIOLOGY: ['radiologist', 'xray doctor'],
  PATHOLOGY: ['pathologist'],
  EMERGENCY_MEDICINE: ['emergency doctor', 'casualty', 'emergency'],
  PHYSIOTHERAPY: ['physiotherapist', 'physio', 'exercise therapy'],
};

export const SERVICE_TERMS: Record<string, string[]> = {
  CONSULT_OPD: ['doctor visit', 'consultation', 'checkup', 'check up', 'opd'],
  LAB_CBC: ['blood test', 'cbc', 'complete blood count', 'hemoglobin test', 'haemoglobin test', 'blood count', 'rokto porikkha', 'khoon ki jaanch'],
  LAB_FBS: ['sugar test', 'blood sugar', 'diabetes test', 'fasting sugar', 'glucose test', 'sugar check'],
  LAB_KFT: ['kidney test', 'kft', 'rft', 'renal function test', 'creatinine test', 'urea test'],
  LAB_LFT: ['liver test', 'lft', 'jaundice test', 'bilirubin test'],
  LAB_LIPID: ['cholesterol test', 'lipid test', 'triglyceride test'],
  LAB_THYROID: ['thyroid test', 'tsh', 't3 t4', 'thyroid check'],
  LAB_URINE_RE: ['urine test', 'urine routine', 'prosrab porikkha', 'peshab test'],
  IMG_XRAY_CHEST: ['chest xray', 'x ray', 'xray', 'chest x ray'],
  IMG_USG_ABDOMEN: ['ultrasound', 'usg', 'sonography', 'abdomen scan', 'pet er usg'],
  IMG_CT_HEAD: ['ct scan', 'head ct', 'brain scan', 'cat scan'],
  PROC_ECG: ['ecg', 'ekg', 'heart tracing'],
  IMG_MRI_BRAIN: ['mri', 'brain mri', 'head mri', 'mri scan'],
  IMG_XRAY_KNEE: ['knee xray', 'knee x ray'],
  IMG_USG_PELVIS: ['pelvis ultrasound', 'lower abdomen ultrasound', 'usg pelvis'],
  PROC_ECHO: ['echo', '2d echo', 'heart echo', 'echo test'],
};

/** Extra everyday words for the starter conditions already in the catalogue. */
export const CONDITION_TERMS: Record<string, string[]> = {
  Fever: ['bukhar', 'jwar', 'jor', 'jwor', 'temperature', 'body temperature', 'high fever'],
  Diabetes: ['sugar problem', 'madhumeho', 'diabetic'],
  'High blood pressure': ['blood pressure', 'high bp', 'pressure', 'presar'],
  'Heart disease': ['palpitation', 'heart beat fast'],
  'Chest pain': ['buke byatha', 'seene me dard', 'chest tightness', 'heart attack'],
  'Difficulty breathing': ['shash kashto', 'saans phoolna', 'breathing difficulty', 'cannot breathe'],
  'Stroke symptoms': ['paralysis', 'lakwa', 'pokkhaghat'],
  'Tooth pain': ['dant byatha', 'daant dard', 'cavity', 'teeth pain', 'gum pain'],
  'Eye infection': ['chokh lal', 'eye pain', 'eye itching'],
  'Skin allergy': ['chulkani', 'khujli', 'skin problem', 'allergy'],
  'Joint pain': ['gathe byatha', 'joron dard', 'jodo mein dard'],
  'Ear pain': ['kaan byatha', 'kaan dard', 'ear discharge'],
  'Depression and anxiety': ['anxiety', 'depression', 'tension', 'mon kharap'],
  Asthma: ['hapani', 'dama'],
  'Kidney stones': ['pathri', 'stone'],
  'Liver disease': ['kamla', 'piliya'],
};

type Map = Array<[string, 'PRIMARY' | 'SECONDARY']>;
export const EXTRA_CONDITIONS: Array<{ name: string; kind?: 'CONDITION' | 'SYMPTOM'; synonyms: string[]; redFlag?: boolean; map: Map }> = [
  { name: 'Headache', kind: 'SYMPTOM', synonyms: ['head pain', 'migraine', 'matha byatha', 'mathar jontrona', 'sir dard', 'sar dard'], map: [['GENERAL_MEDICINE', 'PRIMARY'], ['NEUROLOGY', 'SECONDARY']] },
  { name: 'Stomach pain', kind: 'SYMPTOM', synonyms: ['abdominal pain', 'belly pain', 'tummy ache', 'pet dard', 'pet byatha', 'gastric pain'], map: [['GASTROENTEROLOGY', 'PRIMARY'], ['GENERAL_MEDICINE', 'SECONDARY']] },
  { name: 'Acidity and gas', synonyms: ['acidity', 'gas', 'gas problem', 'gastric', 'heartburn', 'indigestion', 'ambol', 'ombol'], map: [['GASTROENTEROLOGY', 'PRIMARY'], ['GENERAL_MEDICINE', 'SECONDARY']] },
  { name: 'Diarrhoea', kind: 'SYMPTOM', synonyms: ['loose motion', 'loose motions', 'diarrhea', 'pet kharap', 'dast'], map: [['GENERAL_MEDICINE', 'PRIMARY'], ['GASTROENTEROLOGY', 'SECONDARY'], ['PAEDIATRICS', 'SECONDARY']] },
  { name: 'Vomiting', kind: 'SYMPTOM', synonyms: ['nausea', 'vomit', 'bomi', 'ulti'], map: [['GENERAL_MEDICINE', 'PRIMARY'], ['GASTROENTEROLOGY', 'SECONDARY']] },
  { name: 'Cold and cough', kind: 'SYMPTOM', synonyms: ['cough', 'cold', 'runny nose', 'sore throat', 'throat pain', 'sardi', 'sordi', 'khansi', 'kashi', 'gola byatha'], map: [['GENERAL_MEDICINE', 'PRIMARY'], ['ENT', 'SECONDARY'], ['PULMONOLOGY', 'SECONDARY']] },
  { name: 'Back pain', kind: 'SYMPTOM', synonyms: ['lower back pain', 'spine pain', 'komor byatha', 'kamar dard'], map: [['ORTHOPAEDICS', 'PRIMARY'], ['PHYSIOTHERAPY', 'SECONDARY']] },
  { name: 'Weakness and tiredness', kind: 'SYMPTOM', synonyms: ['weakness', 'fatigue', 'tiredness', 'dizziness', 'durbol', 'kamjori', 'matha ghora'], map: [['GENERAL_MEDICINE', 'PRIMARY']] },
  { name: 'Dengue', synonyms: ['dengue fever'], map: [['GENERAL_MEDICINE', 'PRIMARY']] },
  { name: 'Malaria', synonyms: ['malaria fever'], map: [['GENERAL_MEDICINE', 'PRIMARY']] },
  { name: 'Typhoid', synonyms: ['enteric fever', 'typhoid fever'], map: [['GENERAL_MEDICINE', 'PRIMARY']] },
  { name: 'Urine infection', synonyms: ['uti', 'burning urine', 'urinary infection', 'prosrab jala', 'peshab me jalan'], map: [['UROLOGY', 'PRIMARY'], ['GENERAL_MEDICINE', 'SECONDARY']] },
  { name: 'Period problems', synonyms: ['irregular periods', 'period pain', 'menstrual pain', 'white discharge', 'masik'], map: [['OBSTETRICS_GYNAECOLOGY', 'PRIMARY']] },
  { name: 'Hair fall', synonyms: ['hair loss', 'dandruff', 'chul pora', 'baal jhadna'], map: [['DERMATOLOGY', 'PRIMARY']] },
  { name: 'Acne', synonyms: ['pimples', 'pimple', 'bron'], map: [['DERMATOLOGY', 'PRIMARY']] },
  { name: 'Piles', synonyms: ['haemorrhoids', 'hemorrhoids', 'fissure', 'arsh'], map: [['GENERAL_SURGERY', 'PRIMARY'], ['GASTROENTEROLOGY', 'SECONDARY']] },
  { name: 'Hernia', synonyms: ['inguinal hernia'], map: [['GENERAL_SURGERY', 'PRIMARY']] },
  { name: 'Fracture', synonyms: ['broken bone', 'bone fracture', 'har bhanga', 'haddi tootna'], map: [['ORTHOPAEDICS', 'PRIMARY'], ['EMERGENCY_MEDICINE', 'SECONDARY']] },
  { name: 'Vision problem', synonyms: ['blurry vision', 'weak eyesight', 'need glasses', 'cataract', 'chokhe kom dekha'], map: [['OPHTHALMOLOGY', 'PRIMARY']] },
  { name: 'Hearing problem', synonyms: ['hearing loss', 'kaane kom shona'], map: [['ENT', 'PRIMARY']] },
  { name: 'Tonsillitis', synonyms: ['tonsils', 'tonsil'], map: [['ENT', 'PRIMARY']] },
  { name: 'Sinusitis', synonyms: ['sinus', 'blocked nose'], map: [['ENT', 'PRIMARY']] },
  { name: 'Anaemia', synonyms: ['anemia', 'low hemoglobin', 'low haemoglobin', 'rokto kom', 'khoon ki kami'], map: [['GENERAL_MEDICINE', 'PRIMARY']] },
  { name: 'Obesity', synonyms: ['weight gain', 'overweight', 'motapa'], map: [['ENDOCRINOLOGY', 'PRIMARY'], ['GENERAL_MEDICINE', 'SECONDARY']] },
  { name: 'Sleep problems', synonyms: ['insomnia', 'cannot sleep', 'ghum hoy na', 'neend nahi'], map: [['PSYCHIATRY', 'PRIMARY'], ['GENERAL_MEDICINE', 'SECONDARY']] },
  { name: 'Epilepsy', synonyms: ['fits', 'seizures', 'mirgi'], map: [['NEUROLOGY', 'PRIMARY']] },
  // Red flags: the app shows the emergency number before any listing.
  { name: 'Unconscious or fainting', kind: 'SYMPTOM', redFlag: true, synonyms: ['unconscious', 'fainted', 'fainting', 'behosh', 'ojnan'], map: [['EMERGENCY_MEDICINE', 'PRIMARY']] },
  { name: 'Heavy bleeding', kind: 'SYMPTOM', redFlag: true, synonyms: ['severe bleeding', 'bleeding a lot', 'khub rokto'], map: [['EMERGENCY_MEDICINE', 'PRIMARY']] },
  { name: 'Snake bite', kind: 'SYMPTOM', redFlag: true, synonyms: ['snakebite', 'shaap kamor', 'saap kata', 'saanp ne kata'], map: [['EMERGENCY_MEDICINE', 'PRIMARY']] },
  { name: 'Poisoning', kind: 'SYMPTOM', redFlag: true, synonyms: ['poison', 'swallowed poison', 'bish', 'zeher'], map: [['EMERGENCY_MEDICINE', 'PRIMARY']] },
  { name: 'Road accident or injury', kind: 'SYMPTOM', redFlag: true, synonyms: ['accident', 'road accident', 'serious injury', 'durghotona'], map: [['EMERGENCY_MEDICINE', 'PRIMARY'], ['ORTHOPAEDICS', 'SECONDARY']] },
  { name: 'Severe burns', kind: 'SYMPTOM', redFlag: true, synonyms: ['burn', 'burns', 'pura gechhe', 'jal gaya'], map: [['EMERGENCY_MEDICINE', 'PRIMARY'], ['DERMATOLOGY', 'SECONDARY']] },
];

/** Union, lowercase, de-duplicated, keeping the existing order first. */
export function mergeTerms(existing: string[], extra: string[] = []): string[] {
  const out: string[] = [];
  for (const t of [...existing, ...extra].map((x) => x.trim().toLowerCase()).filter(Boolean)) if (!out.includes(t)) out.push(t);
  return out.slice(0, 40);
}

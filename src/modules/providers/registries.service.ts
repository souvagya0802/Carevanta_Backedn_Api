import { prisma, type Db } from '../../lib/prisma.js';
import { decryptField, encryptField } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, notFound, preconditionFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { setSetting } from '../platform/integrations.service.js';
import { gstinChecksumValid, isoDate } from '../../http/dto.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { DocumentType, ProviderType, VerificationCheckType } from '../../../generated/prisma/client.js';

/**
 * Verification orchestration (see docs/requirements §13): there is no single
 * government API that verifies every identifier. Each check maps to the
 * registry that is authoritative for it. Some registries expose APIs to
 * integrators (ABDM's HPR/HFR, GSTN through GSPs, Vahan through authorised
 * partners); most only offer a public search page. This module tells the
 * verifier *where* to look, pre-validates what is on file, and runs the
 * automatic lookup where a connector has been configured in Settings.
 */

// ─── Registry catalogue ────────────────────────────────────────────────────
export type LookupMode = 'api' | 'portal' | 'none';
export interface RegistryInfo {
  key: string;
  name: string;
  authority: string;
  /** Which checks this registry is authoritative for. */
  checkTypes: VerificationCheckType[];
  /** Provider types it applies to (empty = any). */
  providerTypes: ProviderType[];
  /** 'api' needs a configured connector; 'portal' is a manual search page; 'none' = issuer confirmation only. */
  mode: LookupMode;
  portalUrl: string | null;
  /** Which connector (Settings → Registries) powers the API mode. */
  connector: 'abdm' | 'gstin' | 'vahan' | null;
  /** What the verifier should compare and record. */
  guidance: string;
  /** Document types that evidence this check. */
  evidenceDocuments: DocumentType[];
}

export const REGISTRIES: readonly RegistryInfo[] = [
  {
    key: 'nmc_nmr',
    name: 'National Medical Register (NMC)',
    authority: 'National Medical Commission',
    checkTypes: ['PROFESSIONAL_REGISTRATION'],
    providerTypes: ['DOCTOR'],
    mode: 'portal',
    portalUrl: 'https://www.nmc.org.in/information-desk/indian-medical-register/',
    connector: null,
    guidance: 'Search by registration number and State Medical Council. Match the name, council, year and status (active / suspended). Record the NMR ID or the search URL as the source reference. Councils for AYUSH, dentistry and nursing have their own registers.',
    evidenceDocuments: ['MEDICAL_REGISTRATION_CERTIFICATE'],
  },
  {
    key: 'abdm_hpr',
    name: 'Healthcare Professionals Registry (ABDM)',
    authority: 'National Health Authority',
    checkTypes: ['PROFESSIONAL_REGISTRATION'],
    providerTypes: ['DOCTOR'],
    mode: 'api',
    portalUrl: 'https://hpr.abdm.gov.in/',
    connector: 'abdm',
    guidance: 'If the doctor has an HPR ID, the ABDM registry confirms the council registration they enrolled with. Needs ABDM sandbox/production credentials (Settings → Registries).',
    evidenceDocuments: ['MEDICAL_REGISTRATION_CERTIFICATE'],
  },
  {
    key: 'university_degree',
    name: 'Awarding university / institution',
    authority: 'Issuing institution',
    checkTypes: ['QUALIFICATION'],
    providerTypes: ['DOCTOR'],
    mode: 'none',
    portalUrl: null,
    connector: null,
    guidance: 'Degrees are confirmed by the institution (or DigiLocker-issued certificates). Accept the degree certificate, and for post-graduate claims check the NMC-recognised qualification list.',
    evidenceDocuments: ['DEGREE_CERTIFICATE'],
  },
  {
    key: 'state_pharmacy_council',
    name: 'State Pharmacy Council register',
    authority: 'Pharmacy Council of India / State Pharmacy Council',
    checkTypes: ['PROFESSIONAL_REGISTRATION'],
    providerTypes: ['PHARMACY'],
    mode: 'portal',
    portalUrl: 'https://www.pci.nic.in/',
    connector: null,
    guidance: 'The registered pharmacist named on the drug licence must hold a live State Pharmacy Council registration. Match the name and registration number.',
    evidenceDocuments: ['PHARMACIST_REGISTRATION'],
  },
  {
    key: 'clinical_establishments',
    name: 'Clinical Establishments registry',
    authority: 'State health department (CEA / state Act) · CERRS',
    checkTypes: ['FACILITY_REGISTRATION'],
    providerTypes: ['HOSPITAL', 'CLINIC', 'DIAGNOSTIC_LAB', 'IMAGING_CENTRE'],
    mode: 'portal',
    portalUrl: 'http://clinicalestablishments.gov.in/AuthenticatedPages/cms/Views/SearchCE.aspx',
    connector: null,
    guidance: 'Applicability varies by state. West Bengal registers establishments under its own 2017 Act through the WB Health portal; use the certificate number, issuing authority (e.g. CMOH) and validity. Where the national CERRS search lists the establishment, record the search result.',
    evidenceDocuments: ['CLINICAL_ESTABLISHMENT_REGISTRATION', 'TRADE_LICENSE'],
  },
  {
    key: 'abdm_hfr',
    name: 'Health Facility Registry (ABDM)',
    authority: 'National Health Authority',
    checkTypes: ['FACILITY_REGISTRATION'],
    providerTypes: ['HOSPITAL', 'CLINIC', 'DIAGNOSTIC_LAB', 'IMAGING_CENTRE', 'PHARMACY'],
    mode: 'api',
    portalUrl: 'https://facility.abdm.gov.in/',
    connector: 'abdm',
    guidance: 'A facility with an HFR ID has been approved by a state/district officer. Needs ABDM credentials; the facility search endpoint is confirmed against the HFR Swagger before go-live.',
    evidenceDocuments: ['CLINICAL_ESTABLISHMENT_REGISTRATION'],
  },
  {
    key: 'gstn',
    name: 'GST taxpayer search',
    authority: 'Goods and Services Tax Network',
    checkTypes: ['TAX_REGISTRATION'],
    providerTypes: [],
    mode: 'api',
    portalUrl: 'https://services.gst.gov.in/services/searchtp',
    connector: 'gstin',
    guidance: 'The GSTIN must be active and the legal name must match the provider. Direct API access is via a GST Suvidha Provider or a verification vendor; without one, use the public search page.',
    evidenceDocuments: ['GST_CERTIFICATE'],
  },
  {
    key: 'state_drugs_control',
    name: 'State Drugs Control licence register',
    authority: 'State Drugs Controller (Drugs and Cosmetics Rules)',
    checkTypes: ['DRUG_LICENSE'],
    providerTypes: ['PHARMACY'],
    mode: 'portal',
    portalUrl: 'https://cdscoonline.gov.in/',
    connector: null,
    guidance: 'Retail (Form 20/21) and wholesale (20B/21B) licences are issued per premises and expire. Check the premises address matches the store location and the licence is in date. Many states list licensees on their drugs-control portal.',
    evidenceDocuments: ['DRUG_LICENSE'],
  },
  {
    key: 'aerb',
    name: 'AERB e-LORA licence',
    authority: 'Atomic Energy Regulatory Board',
    checkTypes: ['RADIOLOGY_LICENSE'],
    providerTypes: ['IMAGING_CENTRE', 'DIAGNOSTIC_LAB', 'HOSPITAL'],
    mode: 'none',
    portalUrl: 'https://elora.aerb.gov.in/',
    connector: null,
    guidance: 'X-ray, CT and mammography equipment needs an AERB licence per machine; ultrasound needs PC-PNDT registration from the district authority. The licensee sees their status in e-LORA; ask for the licence certificate and verify the equipment serial numbers.',
    evidenceDocuments: ['AERB_LICENSE', 'PCPNDT_REGISTRATION'],
  },
  {
    key: 'nabl',
    name: 'NABL accredited laboratory directory',
    authority: 'National Accreditation Board for Testing and Calibration Laboratories',
    checkTypes: ['ACCREDITATION'],
    providerTypes: ['DIAGNOSTIC_LAB', 'IMAGING_CENTRE', 'HOSPITAL'],
    mode: 'portal',
    portalUrl: 'https://nabl-india.org/',
    connector: null,
    guidance: 'Search the public directory by certificate number or lab name; confirm the scope and validity date. NABH accreditations are listed on the NABH portal.',
    evidenceDocuments: ['NABL_ACCREDITATION'],
  },
  {
    key: 'vahan',
    name: 'Vahan vehicle registration',
    authority: 'Ministry of Road Transport and Highways',
    checkTypes: ['VEHICLE_REGISTRATION', 'VEHICLE_INSURANCE'],
    providerTypes: ['AMBULANCE_OPERATOR'],
    mode: 'api',
    portalUrl: 'https://vahan.parivahan.gov.in/vahanservice/vahan/ui/statevalidation/homepage.xhtml',
    connector: 'vahan',
    guidance: 'RC status, insurance validity, fitness and permit come from the Vahan database through an authorised partner API; the public portal shows RC status only. Ambulances must be registered as such and carry a valid permit.',
    evidenceDocuments: ['VEHICLE_REGISTRATION_CERTIFICATE', 'VEHICLE_INSURANCE', 'VEHICLE_FITNESS_CERTIFICATE', 'VEHICLE_PERMIT'],
  },
  {
    key: 'identity',
    name: 'Government identity document',
    authority: 'UIDAI / DigiLocker / issuing authority',
    checkTypes: ['IDENTITY'],
    providerTypes: [],
    mode: 'none',
    portalUrl: 'https://www.digilocker.gov.in/',
    connector: null,
    guidance: 'Match the identity document to the name on the registration. Do not store Aadhaar numbers; record the document type and a masked reference. DigiLocker-issued documents are the strongest evidence.',
    evidenceDocuments: ['IDENTITY_PROOF'],
  },
  {
    key: 'address',
    name: 'Premises address',
    authority: 'Physical inspection / utility bill / licence address',
    checkTypes: ['ADDRESS'],
    providerTypes: [],
    mode: 'none',
    portalUrl: null,
    connector: null,
    guidance: 'The map pin and postal address must agree with the address on the establishment registration or trade licence. A physical visit or a geotagged photo is the usual evidence for the pilot.',
    evidenceDocuments: ['TRADE_LICENSE', 'CLINICAL_ESTABLISHMENT_REGISTRATION'],
  },
  {
    key: 'bank',
    name: 'Payout bank account',
    authority: 'Penny-drop / cancelled cheque',
    checkTypes: ['BANK_ACCOUNT'],
    providerTypes: [],
    mode: 'none',
    portalUrl: null,
    connector: null,
    guidance: 'Verified through the payout-account maker-checker flow on the provider page, not here. The account name must match the legal name.',
    evidenceDocuments: ['BANK_PROOF'],
  },
];

// ─── Connector configuration (Settings → Registries) ───────────────────────
export interface RegistryConnectors {
  abdm: { environment: 'sandbox' | 'production'; clientId: string | null; hasSecret: boolean; hprLookupUrl: string | null; hfrLookupUrl: string | null };
  gstin: { baseUrl: string | null; hasApiKey: boolean };
  vahan: { baseUrl: string | null; hasApiKey: boolean };
}
const KEYS = ['registry.abdm.environment', 'registry.abdm.clientId', 'registry.abdm.clientSecret', 'registry.abdm.hprLookupUrl', 'registry.abdm.hfrLookupUrl', 'registry.gstin.baseUrl', 'registry.gstin.apiKey', 'registry.vahan.baseUrl', 'registry.vahan.apiKey'] as const;

async function rawConfig(db: Db = prisma) {
  const rows = await db.platformSetting.findMany({ where: { key: { in: [...KEYS] } } });
  const get = (k: (typeof KEYS)[number]) => {
    const v = rows.find((r) => r.key === k)?.value;
    return typeof v === 'string' && v ? v : null;
  };
  const secret = (k: 'registry.abdm.clientSecret' | 'registry.gstin.apiKey' | 'registry.vahan.apiKey') => {
    const enc = get(k);
    if (!enc) return null;
    try { return decryptField(enc); } catch (err) { logger.error({ err, key: k }, 'registry secret could not be decrypted'); return null; }
  };
  return { get, secret };
}

export async function getRegistryConnectors(db: Db = prisma): Promise<RegistryConnectors> {
  const { get, secret } = await rawConfig(db);
  return {
    abdm: { environment: get('registry.abdm.environment') === 'production' ? 'production' : 'sandbox', clientId: get('registry.abdm.clientId'), hasSecret: !!secret('registry.abdm.clientSecret'), hprLookupUrl: get('registry.abdm.hprLookupUrl'), hfrLookupUrl: get('registry.abdm.hfrLookupUrl') },
    gstin: { baseUrl: get('registry.gstin.baseUrl'), hasApiKey: !!secret('registry.gstin.apiKey') },
    vahan: { baseUrl: get('registry.vahan.baseUrl'), hasApiKey: !!secret('registry.vahan.apiKey') },
  };
}

export async function saveRegistryConnectors(
  db: Db,
  input: {
    abdm?: { environment?: 'sandbox' | 'production'; clientId?: string | null; clientSecret?: string | null; hprLookupUrl?: string | null; hfrLookupUrl?: string | null };
    gstin?: { baseUrl?: string | null; apiKey?: string | null };
    vahan?: { baseUrl?: string | null; apiKey?: string | null };
  },
  updatedById: string,
) {
  const put = (key: string, value: string | null | undefined, description: string, sensitive = false) => {
    if (value === undefined) return Promise.resolve();
    return setSetting(db, key, value ? (sensitive ? encryptField(value) : value) : '', description, sensitive, updatedById);
  };
  await put('registry.abdm.environment', input.abdm?.environment, 'ABDM gateway: sandbox or production');
  await put('registry.abdm.clientId', input.abdm?.clientId, 'ABDM client id');
  await put('registry.abdm.clientSecret', input.abdm?.clientSecret, 'ABDM client secret (encrypted)', true);
  await put('registry.abdm.hprLookupUrl', input.abdm?.hprLookupUrl, 'HPR professional lookup endpoint (confirmed against NHA docs)');
  await put('registry.abdm.hfrLookupUrl', input.abdm?.hfrLookupUrl, 'HFR facility lookup endpoint (confirmed against NHA docs)');
  await put('registry.gstin.baseUrl', input.gstin?.baseUrl, 'GSTIN verification API base URL (GSP or vendor)');
  await put('registry.gstin.apiKey', input.gstin?.apiKey, 'GSTIN verification API key (encrypted)', true);
  await put('registry.vahan.baseUrl', input.vahan?.baseUrl, 'Vahan RC verification API base URL (authorised partner)');
  await put('registry.vahan.apiKey', input.vahan?.apiKey, 'Vahan RC verification API key (encrypted)', true);
}

export const ABDM_GATEWAY = { sandbox: 'https://dev.abdm.gov.in/gateway/v0.5/sessions', production: 'https://live.abdm.gov.in/gateway/v0.5/sessions' } as const;

/** Obtain a gateway session token; used by the Settings "test connection" button and by lookups. */
export async function abdmSession(db: Db = prisma): Promise<{ accessToken: string; expiresIn: number | null; environment: 'sandbox' | 'production' }> {
  const { get, secret } = await rawConfig(db);
  const environment = get('registry.abdm.environment') === 'production' ? 'production' : 'sandbox';
  const clientId = get('registry.abdm.clientId');
  const clientSecret = secret('registry.abdm.clientSecret');
  if (!clientId || !clientSecret) throw preconditionFailed('ABDM client id and secret are not configured');
  const res = await fetch(ABDM_GATEWAY[environment], { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ clientId, clientSecret }), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw badRequest(`ABDM gateway refused the credentials (HTTP ${res.status})`);
  const json = (await res.json()) as { accessToken?: string; expiresIn?: number };
  if (!json.accessToken) throw badRequest('ABDM gateway returned no access token');
  return { accessToken: json.accessToken, expiresIn: json.expiresIn ?? null, environment };
}

export async function connectorStatus(db: Db = prisma): Promise<Record<'abdm' | 'gstin' | 'vahan', 'configured' | 'not_configured'>> {
  const c = await getRegistryConnectors(db);
  return {
    abdm: c.abdm.clientId && c.abdm.hasSecret ? 'configured' : 'not_configured',
    gstin: c.gstin.baseUrl && c.gstin.hasApiKey ? 'configured' : 'not_configured',
    vahan: c.vahan.baseUrl && c.vahan.hasApiKey ? 'configured' : 'not_configured',
  };
}

// ─── Identifier validation ─────────────────────────────────────────────────
/** GST state code → state name (first two GSTIN digits). */
const GST_STATE: Record<string, string> = { '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh' };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

// ─── Per-case guidance ─────────────────────────────────────────────────────
export interface CheckGuidance {
  checkType: VerificationCheckType;
  registries: { key: string; name: string; mode: LookupMode; portalUrl: string | null; lookupAvailable: boolean; connector: string | null; guidance: string }[];
  /** What is on file for this check, labelled. */
  identifiers: { label: string; value: string }[];
  /** Problems a verifier should resolve before passing the check. */
  warnings: string[];
  /** Documents that would evidence this check and whether an ACCEPTED one exists. */
  evidence: { documentType: DocumentType; status: 'ACCEPTED' | 'UPLOADED' | 'REJECTED' | 'EXPIRED' | 'MISSING'; documentId: string | null; expiresAt: string | null }[];
}

export async function caseGuidance(caseId: string): Promise<{ caseId: string; checks: CheckGuidance[]; connectors: Awaited<ReturnType<typeof connectorStatus>> }> {
  const c = await prisma.verificationCase.findUnique({
    where: { id: caseId },
    include: {
      checks: true,
      provider: {
        include: {
          doctorProfile: { include: { registrations: true, qualifications: true } },
          facilityProfile: true,
          diagnosticProfile: true,
          pharmacyProfile: true,
          ambulanceProfile: true,
          vehicles: true,
          locations: { where: { isActive: true }, orderBy: { isPrimary: 'desc' } },
          documents: { where: { status: { in: ['UPLOADED', 'ACCEPTED', 'REJECTED'] } }, orderBy: { createdAt: 'desc' } },
          payoutAccounts: true,
        },
      },
    },
  });
  if (!c) throw notFound('Verification case');
  const p = c.provider;
  const connectors = await connectorStatus();
  const primary = p.locations[0];
  const today = new Date();

  const evidenceFor = (types: DocumentType[]) =>
    types.map((documentType) => {
      const docs = p.documents.filter((d) => d.documentType === documentType);
      const accepted = docs.find((d) => d.status === 'ACCEPTED');
      const uploaded = docs.find((d) => d.status === 'UPLOADED');
      const rejected = docs.find((d) => d.status === 'REJECTED');
      const pick = accepted ?? uploaded ?? rejected ?? null;
      const expired = !!(pick?.expiresAt && pick.expiresAt < today);
      return { documentType, status: !pick ? ('MISSING' as const) : expired ? ('EXPIRED' as const) : (pick.status as 'ACCEPTED' | 'UPLOADED' | 'REJECTED'), documentId: pick?.id ?? null, expiresAt: isoDate(pick?.expiresAt ?? null) };
    });

  const checks: CheckGuidance[] = c.checks.map((k) => {
    const regs = REGISTRIES.filter((r) => r.checkTypes.includes(k.checkType) && (r.providerTypes.length === 0 || r.providerTypes.includes(p.type)));
    const identifiers: { label: string; value: string }[] = [];
    const warnings: string[] = [];
    switch (k.checkType) {
      case 'PROFESSIONAL_REGISTRATION':
        if (p.type === 'DOCTOR') {
          for (const r of p.doctorProfile?.registrations ?? []) {
            identifiers.push({ label: `${r.council} registration`, value: r.registrationNumber + (r.registrationYear ? ` (${r.registrationYear})` : '') });
            if (r.validUntil && r.validUntil < today) warnings.push(`Council registration ${r.registrationNumber} expired on ${isoDate(r.validUntil)}`);
            if (primary && !norm(r.council).includes(norm(primary.state)) && !/national/i.test(r.council)) warnings.push(`Council "${r.council}" is not the ${primary.state} council — confirm the doctor also holds (or has transferred) registration where they practise`);
          }
          if (!(p.doctorProfile?.registrations.length)) warnings.push('No council registration on file');
        } else if (p.type === 'PHARMACY') {
          const ph = p.pharmacyProfile;
          if (ph?.pharmacistName) identifiers.push({ label: 'Registered pharmacist', value: ph.pharmacistName });
          if (ph?.pharmacistRegistrationNo) identifiers.push({ label: 'Pharmacy Council registration', value: ph.pharmacistRegistrationNo });
          else warnings.push('No pharmacist registration number on file');
        }
        break;
      case 'QUALIFICATION':
        for (const q of p.doctorProfile?.qualifications ?? []) identifiers.push({ label: q.degree, value: `${q.institution}${q.yearAwarded ? ` · ${q.yearAwarded}` : ''}` });
        if (!(p.doctorProfile?.qualifications.length)) warnings.push('No qualifications on file — at least the primary medical degree is expected');
        break;
      case 'FACILITY_REGISTRATION': {
        const no = p.facilityProfile?.establishmentRegistrationNo ?? p.diagnosticProfile?.establishmentRegistrationNo ?? null;
        if (no) identifiers.push({ label: 'Clinical establishment registration', value: no });
        else warnings.push('No clinical establishment registration number on file — required in West Bengal under the 2017 Act');
        if (p.facilityProfile?.establishmentRegistrationAuth) identifiers.push({ label: 'Issuing authority', value: p.facilityProfile.establishmentRegistrationAuth });
        if (p.registrationNumber) identifiers.push({ label: 'Business registration', value: p.registrationNumber });
        break;
      }
      case 'TAX_REGISTRATION':
        if (p.gstin) {
          identifiers.push({ label: 'GSTIN', value: p.gstin });
          if (!gstinChecksumValid(p.gstin)) warnings.push('GSTIN checksum is invalid — almost certainly a typo');
          const st = GST_STATE[p.gstin.slice(0, 2)];
          if (st && primary && norm(st) !== norm(primary.state)) warnings.push(`GSTIN state code says ${st} but the primary location is in ${primary.state}`);
          const pan = p.gstin.slice(2, 12);
          const entity = pan[3];
          if (p.type === 'DOCTOR' && entity !== 'P') warnings.push('A doctor\'s GSTIN should be on an individual PAN (4th character P)');
          if (p.type !== 'DOCTOR' && entity === 'P') warnings.push('GSTIN is on an individual PAN — fine for a proprietorship, otherwise expect a company/firm/trust PAN');
        } else identifiers.push({ label: 'GSTIN', value: 'Not provided (optional below the registration threshold)' });
        break;
      case 'DRUG_LICENSE': {
        const ph = p.pharmacyProfile;
        if (ph?.retailDrugLicenseNo) identifiers.push({ label: 'Retail drug licence (Form 20/21)', value: ph.retailDrugLicenseNo });
        if (ph?.wholesaleDrugLicenseNo) identifiers.push({ label: 'Wholesale drug licence (Form 20B/21B)', value: ph.wholesaleDrugLicenseNo });
        if (!ph?.retailDrugLicenseNo && !ph?.wholesaleDrugLicenseNo) warnings.push('No drug licence number on file');
        if (ph?.drugLicenseValidUntil) {
          identifiers.push({ label: 'Licence valid until', value: isoDate(ph.drugLicenseValidUntil)! });
          if (ph.drugLicenseValidUntil < today) warnings.push('Drug licence has expired');
          else if (ph.drugLicenseValidUntil.getTime() - today.getTime() < 60 * 86_400_000) warnings.push('Drug licence expires within 60 days — set the check\'s valid-until date accordingly');
        } else warnings.push('No licence expiry date on file');
        break;
      }
      case 'RADIOLOGY_LICENSE': {
        const dx = p.diagnosticProfile;
        if (dx?.aerbLicenseNo) identifiers.push({ label: 'AERB licence', value: dx.aerbLicenseNo });
        if (dx?.pcpndtRegistrationNo) identifiers.push({ label: 'PC-PNDT registration', value: dx.pcpndtRegistrationNo });
        if (dx?.offersImaging && !dx.aerbLicenseNo && !dx.pcpndtRegistrationNo) warnings.push('Imaging is offered but neither an AERB licence nor a PC-PNDT registration is on file');
        break;
      }
      case 'ACCREDITATION': {
        const dx = p.diagnosticProfile;
        if (dx?.nablCertificateNo) identifiers.push({ label: 'NABL certificate', value: dx.nablCertificateNo + (dx.nablScope ? ` · ${dx.nablScope}` : '') });
        const acc = (p.facilityProfile?.accreditations ?? []) as string[];
        if (acc.length) identifiers.push({ label: 'Claimed accreditations', value: acc.join(', ') });
        if (!dx?.nablCertificateNo && !acc.length) identifiers.push({ label: 'Accreditation', value: 'None claimed — waive if not applicable' });
        break;
      }
      case 'VEHICLE_REGISTRATION':
      case 'VEHICLE_INSURANCE':
        for (const v of p.vehicles) {
          const veh = v as unknown as { registrationNumber?: string; insuranceValidUntil?: Date | null; fitnessValidUntil?: Date | null; permitValidUntil?: Date | null; vehicleType?: string };
          if (veh.registrationNumber) identifiers.push({ label: `Vehicle${veh.vehicleType ? ` (${veh.vehicleType})` : ''}`, value: veh.registrationNumber });
          if (k.checkType === 'VEHICLE_INSURANCE' && veh.insuranceValidUntil && veh.insuranceValidUntil < today) warnings.push(`Insurance for ${veh.registrationNumber} expired on ${isoDate(veh.insuranceValidUntil)}`);
          if (k.checkType === 'VEHICLE_REGISTRATION' && veh.fitnessValidUntil && veh.fitnessValidUntil < today) warnings.push(`Fitness certificate for ${veh.registrationNumber} expired on ${isoDate(veh.fitnessValidUntil)}`);
        }
        if (p.vehicles.length === 0) warnings.push('No vehicles on file — add them on the provider page before this check can pass');
        break;
      case 'ADDRESS':
        if (primary) identifiers.push({ label: `${primary.isPrimary ? 'Primary' : 'First'} location`, value: `${primary.addressLine1}, ${primary.locality ? `${primary.locality}, ` : ''}${primary.city}, ${primary.district} ${primary.pincode}${primary.latitude ? ` · pinned` : ' · no map pin'}` });
        else warnings.push('No active location — required before approval');
        if (primary && !primary.latitude) warnings.push('Location has no map coordinates; distance search will not find this provider');
        break;
      case 'IDENTITY':
        identifiers.push({ label: 'Legal name', value: p.legalName });
        break;
      case 'BANK_ACCOUNT': {
        const verified = p.payoutAccounts.filter((a) => (a as unknown as { status: string }).status === 'VERIFIED').length;
        identifiers.push({ label: 'Payout accounts', value: `${p.payoutAccounts.length} on file · ${verified} verified` });
        if (p.payoutAccounts.length && !verified) warnings.push('A payout account exists but is not yet verified (maker-checker on the provider page)');
        break;
      }
    }
    const evidenceDocs = Array.from(new Set(regs.flatMap((r) => r.evidenceDocuments)));
    const evidence = evidenceFor(evidenceDocs);
    if (k.isRequired && evidence.length && !evidence.some((e) => e.status === 'ACCEPTED')) {
      if (evidence.some((e) => e.status === 'UPLOADED')) warnings.push('A document is uploaded but not yet reviewed; only ACCEPTED documents count as evidence');
      else if (evidence.some((e) => e.status === 'EXPIRED')) warnings.push('The evidence document on file has expired');
      else if (evidence.every((e) => e.status === 'MISSING')) warnings.push(`No evidence document uploaded (expected: ${evidenceDocs.map((d) => d.toLowerCase().replace(/_/g, ' ')).join(' or ')})`);
    }
    if (k.validUntil && k.validUntil < today) warnings.push(`This check's validity ended on ${isoDate(k.validUntil)} — re-verify`);
    return {
      checkType: k.checkType,
      registries: regs.map((r) => ({ key: r.key, name: r.name, mode: r.mode, portalUrl: r.portalUrl, lookupAvailable: r.mode === 'api' && !!r.connector && connectors[r.connector] === 'configured', connector: r.connector, guidance: r.guidance })),
      identifiers,
      warnings,
      evidence,
    };
  });
  return { caseId, checks, connectors };
}

// ─── Automatic lookups ─────────────────────────────────────────────────────
export interface LookupResult { registry: string; outcome: 'MATCH' | 'NO_MATCH' | 'UNAVAILABLE'; reference: string | null; summary: string; raw: Record<string, unknown> | null }

/**
 * Runs the configured connector for a check. Endpoints for ABDM and vendor
 * APIs are configured, not hardcoded, because they differ by environment and
 * are confirmed with the provider at onboarding. The response is audited and
 * returned so the verifier can record it as evidence; nothing is auto-passed.
 */
export async function runLookup(actor: AuthContext, caseId: string, checkType: VerificationCheckType): Promise<LookupResult> {
  const c = await prisma.verificationCase.findUnique({ where: { id: caseId }, include: { provider: { include: { doctorProfile: { include: { registrations: true } }, vehicles: true } } } });
  if (!c) throw notFound('Verification case');
  const reg = REGISTRIES.find((r) => r.mode === 'api' && r.checkTypes.includes(checkType) && (r.providerTypes.length === 0 || r.providerTypes.includes(c.provider.type)));
  if (!reg || !reg.connector) throw preconditionFailed(`No automatic registry lookup exists for ${checkType.toLowerCase().replace(/_/g, ' ')}; use the registry portal and record the result`);
  const { get, secret } = await rawConfig();
  const status = await connectorStatus();
  if (status[reg.connector] !== 'configured') throw preconditionFailed(`${reg.name} needs its connector configured in Settings → Registries`, { connector: reg.connector });

  let result: LookupResult;
  try {
    if (reg.connector === 'gstin') {
      const gstin = c.provider.gstin;
      if (!gstin) throw badRequest('No GSTIN on file');
      const base = get('registry.gstin.baseUrl')!.replace(/\/$/, '');
      const res = await fetch(`${base}/${encodeURIComponent(gstin)}`, { headers: { accept: 'application/json', authorization: `Bearer ${secret('registry.gstin.apiKey')}` }, signal: AbortSignal.timeout(12_000) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const legal = String(json.legalName ?? json.lgnm ?? json.legal_name ?? '');
      const active = /active/i.test(String(json.status ?? json.sts ?? ''));
      const nameMatch = legal ? norm(legal) === norm(c.provider.legalName) : false;
      result = { registry: reg.key, outcome: res.ok && active && nameMatch ? 'MATCH' : res.ok ? 'NO_MATCH' : 'UNAVAILABLE', reference: res.ok ? `GSTN lookup ${gstin} @ ${new Date().toISOString()}` : null, summary: res.ok ? `${legal || 'No legal name returned'} · ${active ? 'active' : 'not active'} · name ${nameMatch ? 'matches' : 'differs from'} "${c.provider.legalName}"` : `Lookup failed (HTTP ${res.status})`, raw: res.ok ? json : null };
    } else if (reg.connector === 'vahan') {
      const vehicle = c.provider.vehicles[0] as unknown as { registrationNumber?: string } | undefined;
      if (!vehicle?.registrationNumber) throw badRequest('No vehicle on file');
      const base = get('registry.vahan.baseUrl')!.replace(/\/$/, '');
      const res = await fetch(`${base}/${encodeURIComponent(vehicle.registrationNumber)}`, { headers: { accept: 'application/json', authorization: `Bearer ${secret('registry.vahan.apiKey')}` }, signal: AbortSignal.timeout(12_000) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const ok = res.ok && /active/i.test(String(json.rcStatus ?? json.status ?? ''));
      result = { registry: reg.key, outcome: ok ? 'MATCH' : res.ok ? 'NO_MATCH' : 'UNAVAILABLE', reference: res.ok ? `Vahan RC ${vehicle.registrationNumber} @ ${new Date().toISOString()}` : null, summary: res.ok ? `RC ${String(json.rcStatus ?? json.status ?? 'status unknown')} · insurance ${String(json.insuranceValidUpto ?? json.insuranceExpiry ?? 'n/a')} · fitness ${String(json.fitnessValidUpto ?? 'n/a')}` : `Lookup failed (HTTP ${res.status})`, raw: res.ok ? json : null };
    } else {
      const url = checkType === 'PROFESSIONAL_REGISTRATION' ? get('registry.abdm.hprLookupUrl') : get('registry.abdm.hfrLookupUrl');
      if (!url) throw preconditionFailed(`The ABDM ${checkType === 'PROFESSIONAL_REGISTRATION' ? 'HPR' : 'HFR'} lookup endpoint is not set — confirm it against the NHA API documents and enter it in Settings → Registries`);
      const session = await abdmSession();
      const body = checkType === 'PROFESSIONAL_REGISTRATION'
        ? { registrationNumber: c.provider.doctorProfile?.registrations[0]?.registrationNumber, council: c.provider.doctorProfile?.registrations[0]?.council, name: c.provider.legalName }
        : { facilityName: c.provider.legalName };
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${session.accessToken}`, 'X-CM-ID': session.environment === 'production' ? 'abdm' : 'sbx' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const found = res.ok && Object.keys(json).length > 0 && !('error' in json);
      result = { registry: reg.key, outcome: found ? 'MATCH' : res.ok ? 'NO_MATCH' : 'UNAVAILABLE', reference: found ? `ABDM ${session.environment} lookup @ ${new Date().toISOString()}` : null, summary: found ? 'Registry returned a record — compare the fields below with what is on file' : res.ok ? 'Registry returned no record' : `Lookup failed (HTTP ${res.status})`, raw: res.ok ? json : null };
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.warn({ err, caseId, checkType }, 'registry lookup failed');
    result = { registry: reg.key, outcome: 'UNAVAILABLE', reference: null, summary: err instanceof Error ? err.message : 'Registry unreachable', raw: null };
  }
  await audit(prisma, { action: 'verification.registry_lookup', entityType: 'verification_case', entityId: caseId, actorUserId: actor.userId, metadata: { checkType, registry: result.registry, outcome: result.outcome, summary: result.summary } });
  return result;
}

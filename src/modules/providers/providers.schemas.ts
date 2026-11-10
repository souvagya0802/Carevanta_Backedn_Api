import { z } from 'zod';
import { DateString, Gstin, MoneyInput, Phone, Pincode } from '../../http/dto.js';

export const ProviderTypeEnum = z.enum([
  'DOCTOR',
  'HOSPITAL',
  'CLINIC',
  'DIAGNOSTIC_LAB',
  'IMAGING_CENTRE',
  'PHARMACY',
  'AMBULANCE_OPERATOR',
]);
export const ProviderStatusEnum = z.enum([
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'DEACTIVATED',
]);

export const LocationInput = z.object({
  name: z.string().trim().min(2).max(160),
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200).optional(),
  locality: z.string().trim().max(120).optional(),
  city: z.string().trim().min(2).max(120),
  district: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode: Pincode,
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  phone: Phone.optional(),
  regionCode: z.string().max(64).optional(),
  isPrimary: z.boolean().default(false),
});

/** A new or existing login identity for the doctor / provider owner. */
const OwnerInput = z.union([
  z.object({ existingUserId: z.uuid() }),
  z.object({
    fullName: z.string().trim().min(2).max(160),
    email: z.email().max(254).optional(),
    phone: Phone.optional(),
  }),
]);

const Core = {
  legalName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).optional(),
  contactEmail: z.email().max(254).optional(),
  contactPhone: Phone.optional(),
  gstin: Gstin.optional(),
  registrationNumber: z.string().trim().max(80).optional(),
  /** Single primary location (kept for older clients). */
  location: LocationInput.optional(),
  /** Several places at once (a doctor's chambers, a chain's branches). The first — or the one flagged — becomes primary. */
  locations: z.array(LocationInput).max(20).optional(),
};

export const DoctorProfileInput = z.object({
  gender: z.enum(['FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED']).optional(),
  yearsOfExperience: z.number().int().min(0).max(70).optional(),
  languages: z.array(z.string().max(32)).max(10).default([]),
  defaultFeeMinor: MoneyInput.optional(),
  bio: z.string().max(4000).optional(),
  specialityCodes: z.array(z.string().max(64)).max(5).default([]),
  primarySpecialityCode: z.string().max(64).optional(),
  qualifications: z
    .array(z.object({ degree: z.string().min(2).max(120), institution: z.string().min(2).max(200), yearAwarded: z.number().int().min(1950).max(2100).optional() }))
    .max(10)
    .default([]),
  registrations: z
    .array(
      z.object({
        council: z.string().trim().min(3).max(160),
        registrationNumber: z.string().trim().min(2).max(64),
        registrationYear: z.number().int().min(1950).max(2100).optional(),
        validUntil: DateString.optional(),
      }),
    )
    .min(1, 'At least one medical council registration is required')
    .max(5),
});

export const FacilityProfileInput = z.object({
  ownershipType: z.enum(['PRIVATE', 'GOVERNMENT', 'TRUST_OR_NGO', 'OTHER']).default('PRIVATE'),
  bedCount: z.number().int().min(0).max(10000).optional(),
  icuBedCount: z.number().int().min(0).max(5000).optional(),
  hasEmergency: z.boolean().default(false),
  isOpen24x7: z.boolean().default(false),
  establishmentRegistrationNo: z.string().max(80).optional(),
  establishmentRegistrationAuth: z.string().max(160).optional(),
  accreditations: z.array(z.string().max(64)).max(10).default([]),
});

export const DiagnosticProfileInput = z.object({
  offersPathology: z.boolean().default(false),
  offersImaging: z.boolean().default(false),
  homeCollectionAvailable: z.boolean().default(false),
  establishmentRegistrationNo: z.string().max(80).optional(),
  nablCertificateNo: z.string().max(80).optional(),
  nablScope: z.string().max(1000).optional(),
  aerbLicenseNo: z.string().max(80).optional(),
  pcpndtRegistrationNo: z.string().max(80).optional(),
  typicalTurnaroundHours: z.number().int().min(1).max(720).optional(),
});

export const PharmacyProfileInput = z.object({
  retailDrugLicenseNo: z.string().max(80).optional(),
  wholesaleDrugLicenseNo: z.string().max(80).optional(),
  drugLicenseValidUntil: DateString.optional(),
  pharmacistName: z.string().max(160).optional(),
  pharmacistRegistrationNo: z.string().max(80).optional(),
  homeDeliveryAvailable: z.boolean().default(false),
});

export const AmbulanceProfileInput = z.object({
  dispatchPhone: Phone.optional(),
  isOpen24x7: z.boolean().default(false),
  fleetSize: z.number().int().min(0).max(1000).optional(),
});

export const CreateProviderInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('DOCTOR'), ...Core, owner: OwnerInput, doctor: DoctorProfileInput }),
  z.object({ type: z.literal('HOSPITAL'), ...Core, owner: OwnerInput.optional(), facility: FacilityProfileInput.default({} as never) }),
  z.object({ type: z.literal('CLINIC'), ...Core, owner: OwnerInput.optional(), facility: FacilityProfileInput.default({} as never) }),
  z.object({ type: z.literal('DIAGNOSTIC_LAB'), ...Core, owner: OwnerInput.optional(), diagnostic: DiagnosticProfileInput.default({} as never) }),
  z.object({ type: z.literal('IMAGING_CENTRE'), ...Core, owner: OwnerInput.optional(), diagnostic: DiagnosticProfileInput.default({} as never) }),
  z.object({ type: z.literal('PHARMACY'), ...Core, owner: OwnerInput.optional(), pharmacy: PharmacyProfileInput.default({} as never) }),
  z.object({ type: z.literal('AMBULANCE_OPERATOR'), ...Core, owner: OwnerInput.optional(), ambulance: AmbulanceProfileInput.default({} as never) }),
]);
export type CreateProviderInput = z.infer<typeof CreateProviderInput>;

export const UpdateProviderInput = z
  .object({
    legalName: Core.legalName.optional(),
    displayName: Core.displayName.optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    contactEmail: z.email().max(254).nullable().optional(),
    contactPhone: Phone.nullable().optional(),
    gstin: Gstin.nullable().optional(),
    registrationNumber: z.string().trim().max(80).nullable().optional(),
    doctor: DoctorProfileInput.omit({ registrations: true, qualifications: true, specialityCodes: true, primarySpecialityCode: true }).partial().optional(),
    facility: FacilityProfileInput.partial().optional(),
    diagnostic: DiagnosticProfileInput.partial().optional(),
    pharmacy: PharmacyProfileInput.partial().optional(),
    ambulance: AmbulanceProfileInput.partial().optional(),
    expectedVersion: z.number().int().min(1).describe('Optimistic concurrency: the version you last read'),
  })
  .strict();

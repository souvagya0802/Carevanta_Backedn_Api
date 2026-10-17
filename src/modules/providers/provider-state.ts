import type { ProviderStatus, ProviderType, VerificationCheckType } from '../../../generated/prisma/client.js';
import type { TransitionMap } from '../../lib/state-machine.js';

export const PROVIDER_TRANSITIONS: TransitionMap<ProviderStatus> = {
  DRAFT: ['SUBMITTED', 'DEACTIVATED'],
  SUBMITTED: ['UNDER_REVIEW', 'CHANGES_REQUESTED', 'REJECTED', 'DEACTIVATED'],
  UNDER_REVIEW: ['CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'DEACTIVATED'],
  CHANGES_REQUESTED: ['SUBMITTED', 'DEACTIVATED'],
  APPROVED: ['SUSPENDED', 'DEACTIVATED'],
  SUSPENDED: ['APPROVED', 'DEACTIVATED'],
  REJECTED: ['SUBMITTED', 'DEACTIVATED'],
  DEACTIVATED: [],
};

/** Providers in these states may take bookings and appear in search. */
export const OPERATIONAL_STATUSES: readonly ProviderStatus[] = ['APPROVED'];

export const FACILITY_TYPES: readonly ProviderType[] = ['HOSPITAL', 'CLINIC'];
export const DIAGNOSTIC_TYPES: readonly ProviderType[] = ['DIAGNOSTIC_LAB', 'IMAGING_CENTRE'];

/**
 * Checks a verification case must pass (or have explicitly waived with a note)
 * before a provider of each type can be approved. Optional checks are created
 * but do not block approval. This is an operational checklist, not legal
 * advice — see docs/compliance.md for the open regulatory questions.
 */
export const VERIFICATION_REQUIREMENTS: Record<
  ProviderType,
  { required: VerificationCheckType[]; optional: VerificationCheckType[] }
> = {
  DOCTOR: { required: ['IDENTITY', 'PROFESSIONAL_REGISTRATION', 'QUALIFICATION'], optional: ['BANK_ACCOUNT'] },
  HOSPITAL: { required: ['FACILITY_REGISTRATION', 'ADDRESS'], optional: ['TAX_REGISTRATION', 'ACCREDITATION', 'BANK_ACCOUNT'] },
  CLINIC: { required: ['FACILITY_REGISTRATION', 'ADDRESS'], optional: ['TAX_REGISTRATION', 'BANK_ACCOUNT'] },
  DIAGNOSTIC_LAB: { required: ['FACILITY_REGISTRATION', 'ADDRESS'], optional: ['ACCREDITATION', 'TAX_REGISTRATION', 'BANK_ACCOUNT'] },
  IMAGING_CENTRE: {
    required: ['FACILITY_REGISTRATION', 'RADIOLOGY_LICENSE', 'ADDRESS'],
    optional: ['ACCREDITATION', 'TAX_REGISTRATION', 'BANK_ACCOUNT'],
  },
  PHARMACY: { required: ['DRUG_LICENSE', 'PROFESSIONAL_REGISTRATION', 'ADDRESS'], optional: ['TAX_REGISTRATION', 'BANK_ACCOUNT'] },
  AMBULANCE_OPERATOR: {
    required: ['IDENTITY', 'VEHICLE_REGISTRATION', 'VEHICLE_INSURANCE'],
    optional: ['TAX_REGISTRATION', 'BANK_ACCOUNT'],
  },
};

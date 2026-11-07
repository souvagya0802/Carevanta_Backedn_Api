/**
 * Single source of truth for platform permissions and system roles. The seed
 * script upserts these rows; route definitions reference `P.*` constants so a
 * typo is a compile error rather than a silently-open endpoint.
 */
export const PERMISSIONS = {
  // Identity & access
  'users.read': 'View user accounts',
  'users.create': 'Create user accounts',
  'users.update': 'Edit permitted user profile fields',
  'users.status': 'Suspend, reactivate or deactivate user accounts',
  'users.anonymise': 'Anonymise a user account under the retention policy',
  'users.sessions.revoke': 'Revoke another user’s sessions',
  'roles.read': 'View roles and permissions',
  'roles.assign': 'Assign and revoke platform roles',
  'roles.manage': 'Create and edit custom roles',

  // Providers
  'providers.read': 'View providers',
  'providers.create': 'Register providers',
  'providers.update': 'Edit provider details',
  'providers.verify': 'Work verification cases and record checks',
  'providers.approve': 'Approve or reject provider applications',
  'providers.suspend': 'Suspend and reactivate providers',
  'providers.documents.read': 'Open provider credential documents',
  'providers.documents.review': 'Accept or reject provider documents',
  'providers.payout.read': 'View provider payout accounts (masked)',
  'providers.payout.manage': 'Add or disable provider payout accounts',
  'providers.payout.verify': 'Verify provider payout accounts',
  'providers.members.manage': 'Manage provider staff membership',

  // Affiliations / catalogue / schedules
  'affiliations.read': 'View doctor–facility affiliations',
  'affiliations.manage': 'Create and change affiliations on behalf of parties',
  'affiliations.verify': 'Verify affiliations',
  'catalogue.read': 'View the clinical and service catalogue',
  'catalogue.manage': 'Edit catalogue entries',
  'catalogue.mappings.review': 'Review condition-to-speciality mappings (clinical reviewer)',
  'schedules.manage': 'Manage doctor schedules and slots',

  // Operations
  'bookings.read': 'View appointments',
  'bookings.manage': 'Create, confirm, reschedule and cancel appointments',
  'diagnostics.read': 'View diagnostic orders',
  'diagnostics.manage': 'Manage diagnostic orders',
  'diagnostics.reports.read': 'Open diagnostic report metadata and files',
  'pharmacy.read': 'View pharmacy orders and inventory',
  'pharmacy.manage': 'Manage pharmacy orders and inventory',
  'pharmacy.prescriptions.read': 'Open prescriptions',
  'ambulance.read': 'View ambulance operators, vehicles and crew',
  'ambulance.manage': 'Manage ambulance vehicles and crew',
  'dispatch.read': 'View emergency dispatch requests',
  'dispatch.manage': 'Escalate, cancel and annotate dispatch requests',

  // Finance
  'finance.read': 'View transactions, payments and ledger',
  'finance.policies.manage': 'Draft commission policies',
  'finance.policies.approve': 'Approve and activate commission policies',
  'finance.policies.legal_review': 'Record legal review outcome on commission policies',
  'finance.refunds.request': 'Request refunds',
  'finance.refunds.approve': 'Approve or reject refunds',
  'finance.settlements.create': 'Prepare settlement batches',
  'finance.settlements.approve': 'Approve settlement batches',
  'finance.settlements.record': 'Record settlement payout evidence',
  'finance.reconcile': 'Run and resolve payment reconciliation',
  'finance.manual.record': 'Record offline payments, manual refunds, ledger adjustments and payment overrides (audited)',

  // Platform
  'reviews.read': 'View patient reviews, including ones awaiting moderation',
  'reviews.moderate': 'Publish, reject or hide patient reviews',
  'support.read': 'View complaints and support cases',
  'support.manage': 'Work complaints and support cases',
  'audit.read': 'Search the audit log',
  'notifications.read': 'View notifications and templates',
  'notifications.manage': 'Edit notification templates',
  'analytics.read': 'View dashboards and operational reports',
  'exports.create': 'Request data exports',
  'exports.read': 'Download completed exports',
  'settings.read': 'View platform settings',
  'settings.manage': 'Change platform settings',
  'regions.manage': 'Manage service regions',
  'compliance.manage': 'Manage consent records, legal holds and incidents',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

export const SENSITIVE_PERMISSIONS: readonly PermissionKey[] = [
  'users.anonymise',
  'roles.assign',
  'roles.manage',
  'providers.approve',
  'providers.documents.read',
  'providers.payout.verify',
  'diagnostics.reports.read',
  'pharmacy.prescriptions.read',
  'finance.policies.approve',
  'finance.refunds.approve',
  'finance.settlements.approve',
  'finance.settlements.record',
  'finance.manual.record',
  'exports.create',
  'settings.manage',
  'compliance.manage',
];

const readOnly = ALL_PERMISSIONS.filter(
  (p) => p.endsWith('.read') && !SENSITIVE_PERMISSIONS.includes(p),
);

export interface SystemRoleDef {
  key: string;
  name: string;
  description: string;
  permissions: readonly PermissionKey[];
}

export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    key: 'SUPER_ADMIN',
    name: 'Super administrator',
    description: 'Platform owner. Holds every permission. Assign to as few people as possible.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'PLATFORM_ADMIN',
    name: 'Platform administrator',
    description: 'Day-to-day administration without finance approvals or role management.',
    permissions: ALL_PERMISSIONS.filter(
      (p) =>
        ![
          'roles.manage',
          'users.anonymise',
          'finance.policies.approve',
          'finance.policies.legal_review',
          'finance.refunds.approve',
          'finance.settlements.approve',
          'finance.settlements.record',
          'finance.manual.record',
          'settings.manage',
          'compliance.manage',
        ].includes(p),
    ),
  },
  {
    key: 'VERIFICATION_OFFICER',
    name: 'Verification officer',
    description: 'Reviews provider credentials and records verification checks.',
    permissions: [
      ...readOnly,
      'providers.verify',
      'providers.approve',
      'providers.documents.read',
      'providers.documents.review',
      'providers.payout.verify',
      'affiliations.verify',
    ],
  },
  {
    key: 'CLINICAL_REVIEWER',
    name: 'Clinical catalogue reviewer',
    description: 'Qualified clinician who reviews condition-to-speciality mappings.',
    permissions: ['catalogue.read', 'catalogue.mappings.review'],
  },
  {
    key: 'FINANCE_OFFICER',
    name: 'Finance officer',
    description: 'Prepares commission policies, refunds and settlements (maker).',
    permissions: [
      ...readOnly,
      'finance.policies.manage',
      'finance.refunds.request',
      'finance.settlements.create',
      'finance.settlements.record',
      'finance.reconcile',
      'providers.payout.read',
    ],
  },
  {
    key: 'FINANCE_APPROVER',
    name: 'Finance approver',
    description: 'Approves policies, refunds and settlements prepared by others (checker).',
    permissions: [
      ...readOnly,
      'finance.policies.approve',
      'finance.refunds.approve',
      'finance.settlements.approve',
      'finance.manual.record',
      'providers.payout.read',
    ],
  },
  {
    key: 'LEGAL_REVIEWER',
    name: 'Legal reviewer',
    description: 'Records legal/compliance review of commission arrangements.',
    permissions: ['finance.read', 'finance.policies.legal_review', 'providers.read'],
  },
  {
    key: 'SUPPORT_AGENT',
    name: 'Support agent',
    description: 'Handles complaints and support cases.',
    permissions: [
      'users.read',
      'providers.read',
      'bookings.read',
      'bookings.manage',
      'support.read',
      'support.manage',
      'reviews.read',
      'reviews.moderate',
      'finance.read',
      'finance.refunds.request',
    ],
  },
  {
    key: 'OPERATIONS_DISPATCHER',
    name: 'Operations dispatcher',
    description: 'Monitors emergency requests and ambulance operations.',
    permissions: ['dispatch.read', 'dispatch.manage', 'ambulance.read', 'providers.read', 'bookings.read'],
  },
  {
    key: 'AUDITOR',
    name: 'Auditor',
    description: 'Read-only access including the audit log.',
    permissions: [...readOnly, 'audit.read'],
  },
];

/** Provider-scoped authority derived from ProviderMember.memberRole. */
export const PROVIDER_MEMBER_CAPABILITIES = {
  // Owners and admins hold every capability for their own organisation only.
  OWNER: ['manage_profile', 'manage_staff', 'manage_affiliations', 'manage_schedules', 'manage_bookings', 'manage_inventory', 'view_finance', 'review_prescriptions', 'publish_reports', 'manage_dispatch'],
  ADMIN: ['manage_profile', 'manage_affiliations', 'manage_schedules', 'manage_bookings', 'manage_inventory', 'view_finance', 'review_prescriptions', 'publish_reports', 'manage_dispatch'],
  STAFF: ['manage_bookings'],
  PHARMACIST: ['manage_bookings', 'manage_inventory', 'review_prescriptions'],
  LAB_TECHNICIAN: ['manage_bookings', 'publish_reports'],
  DISPATCHER: ['manage_dispatch'],
} as const;
export type ProviderCapability = (typeof PROVIDER_MEMBER_CAPABILITIES)[keyof typeof PROVIDER_MEMBER_CAPABILITIES][number];

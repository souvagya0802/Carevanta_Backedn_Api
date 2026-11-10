/**
 * Metadata for platform settings: how each key is labelled, grouped, typed and
 * bounded. The database row is the source of truth for the *value*; this
 * registry is the source of truth for *what a valid value is* and how the admin
 * UI should present it. Keys without metadata are still editable (type-checked
 * only), so adding a setting never requires a dashboard release.
 */
import { validateMemberCapabilities, validatePortalUi } from '../portal/portal-ui.js';
import { validatePatientUi } from '../patient/patient-ui.js';

export type SettingType = 'integer' | 'number' | 'boolean' | 'string' | 'json';
export type SettingRisk = 'low' | 'medium' | 'high';

export interface SettingMeta {
  label: string;
  group: string;
  type: SettingType;
  /** Shown after numeric values, e.g. "minutes". */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Regex source for string settings. */
  pattern?: string;
  patternHint?: string;
  /** Allowed values for string settings. */
  options?: string[];
  risk: SettingRisk;
  /** Operational guidance shown before changing. */
  help?: string;
  /** Code default used by `getSetting(key, fallback)`; the UI offers "reset to default". */
  default: unknown;
  /** Extra validation for JSON settings: returns a readable problem or null. */
  validate?: (value: unknown) => string | null;
  /** Edited through a dedicated screen rather than the generic settings list. */
  editor?: 'portal';
}

export const SETTING_GROUPS: Record<string, { label: string; description: string }> = {
  booking: { label: 'Appointments', description: 'How bookings are confirmed and cancelled.' },
  finance: { label: 'Finance', description: 'Commission and settlement timing.' },
  emergency: { label: 'Emergency', description: 'Ambulance dispatch and the public emergency number.' },
  search: { label: 'Discovery', description: 'How patients find providers.' },
  platform: { label: 'Platform', description: 'General platform behaviour.' },
  portal: { label: 'Provider Portal', description: 'What provider staff see: section names, page copy, banner, support contacts and role permissions.' },
  payments: { label: 'Payments', description: 'Online payment gateways (Razorpay, Stripe). Edited under Settings → Payments.' },
  push: { label: 'Push Notifications', description: 'Web Push (VAPID) keys. Edited under Settings → Push.' },
  patient: { label: 'Patient App', description: 'Home hero, landing page, categories, banner, support and theme colours of the patient app. Edited under Settings → Patient App.' },
  catalogue: { label: 'Medicine Catalogue', description: 'Automatic medicine list updates from Common Drug Codes for India (CDCI).' },
};

export const SETTING_META: Record<string, SettingMeta> = {
  'booking.patient_cancellation_cutoff_minutes': { label: 'Free cancellation cut-off', group: 'booking', type: 'integer', unit: 'minutes before the slot', min: 0, max: 10080, step: 15, risk: 'medium', default: 120, help: 'Cancellations inside this window may attract the provider’s cancellation policy. 0 disables the cut-off.' },
  'booking.require_provider_confirmation': { label: 'Provider confirmation required', group: 'booking', type: 'boolean', risk: 'medium', default: true, help: 'On: new appointments wait as REQUESTED until the provider confirms. Off: they are confirmed instantly when a slot is free.' },
  'catalogue.cdci_sync_enabled': { label: 'Automatic medicine list updates', group: 'catalogue', type: 'boolean', risk: 'medium', default: true, help: 'On: once a month the platform checks for a new CDCI release, validates it and applies it (new medicines added, removed ones marked inactive, admin edits kept). Off: no automatic or manual sync runs.' },
  'catalogue.cdci_source_base_url': { label: 'Medicine list source', group: 'catalogue', type: 'string', pattern: '^https://[^\\s]+$', patternHint: 'An https:// folder address that holds BrandMaster.txt and the other CDCI files', risk: 'high', default: 'https://raw.githubusercontent.com/ohcnetwork/cdci/main/data/source', help: 'Where the CDCI flat files are downloaded from. The default is the CC BY 4.0 GitHub mirror; change only to another trusted copy of the official release.' },
  'booking.reminders_enabled': { label: 'Booking reminders', group: 'booking', type: 'boolean', risk: 'low', default: true, help: 'On: patients get a reminder (in-app, push and email) before each confirmed appointment or scheduled lab booking. Off: no reminders are sent.' },
  'booking.reminder_lead_hours': { label: 'Reminder lead times', group: 'booking', type: 'string', pattern: '^\\s*[0-9]{1,3}(\\s*,\\s*[0-9]{1,3})*\\s*$', patternHint: 'hours separated by commas, e.g. 24,2', risk: 'low', default: '24,2', help: 'How many hours before the booking each reminder goes out. Each value sends one reminder; 0 and values above 168 are ignored. The worker checks every 5 minutes.' },
  'finance.settlement_hold_days': { label: 'Settlement hold period', group: 'finance', type: 'integer', unit: 'days after completion', min: 0, max: 90, step: 1, risk: 'high', default: 7, help: 'Earnings become settleable only after this many days, giving time for refunds and disputes. Shortening it increases refund exposure.' },
  'finance.commission_on_provider_direct': { label: 'Commission on walk-in bookings', group: 'finance', type: 'boolean', risk: 'high', default: false, help: 'Walk-in (PROVIDER_DIRECT) bookings are recorded by the provider themselves. Charging commission on them needs explicit contractual backing.' },
  'emergency.public_number': { label: 'Public emergency number', group: 'emergency', type: 'string', pattern: '^[0-9]{2,6}$', patternHint: '2–6 digits', risk: 'high', default: '112', help: 'Shown first on every emergency screen before any in-app dispatch. In India this is 112.' },
  'emergency.live_dispatch_enabled': { label: 'Live ambulance dispatch', group: 'emergency', type: 'boolean', risk: 'high', default: false, help: 'When on, emergency requests are sent to real partner operators. Enable only with signed operator agreements, a tested escalation rota and completed drills.' },
  'search.default_radius_km': { label: 'Default search radius', group: 'search', type: 'integer', unit: 'km', min: 1, max: 200, step: 1, risk: 'low', default: 15, help: 'Used when a patient searches without choosing a distance.' },
  'portal.ui': { label: 'Portal structure and copy', group: 'portal', type: 'json', risk: 'medium', default: {}, editor: 'portal', validate: validatePortalUi, help: 'Section names, page titles and subtitles per provider type, hidden pages, organisation words, announcement banner and support contacts. Empty means "as shipped". Edit it under Settings → Provider Portal.' },
  'patient.ui': { label: 'Patient app content', group: 'patient', type: 'json', risk: 'medium', default: {}, editor: 'portal', validate: validatePatientUi, help: 'Hero title/subtitle/buttons, landing page copy, category shortcuts, announcement, support contacts and theme colours. Empty means as shipped.' },
  'portal.member_capabilities': { label: 'Provider staff permissions', group: 'portal', type: 'json', risk: 'high', default: {}, editor: 'portal', validate: validateMemberCapabilities, help: 'Which capabilities each provider staff role carries (admin, staff, pharmacist, lab technician, dispatcher). Owners always hold everything. Takes effect within 30 seconds for every provider.' },
};

const jsType = (v: unknown): SettingType => (typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v === 'string' ? 'string' : 'json');

/** Returns a human-readable problem with `value` for `key`, or null when it is acceptable. */
export function validateSettingValue(key: string, current: unknown, value: unknown): string | null {
  const meta = SETTING_META[key];
  const expected = meta?.type ?? jsType(current);
  switch (expected) {
    case 'boolean':
      if (typeof value !== 'boolean') return 'This setting expects true or false';
      return null;
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'This setting expects a number';
      if (expected === 'integer' && !Number.isInteger(value)) return 'This setting expects a whole number';
      if (meta?.min != null && value < meta.min) return `Must be at least ${meta.min}${meta.unit ? ` ${meta.unit}` : ''}`;
      if (meta?.max != null && value > meta.max) return `Must be at most ${meta.max}${meta.unit ? ` ${meta.unit}` : ''}`;
      return null;
    }
    case 'string': {
      if (typeof value !== 'string') return 'This setting expects text';
      if (!value.trim()) return 'A value is required';
      if (meta?.options && !meta.options.includes(value)) return `Must be one of: ${meta.options.join(', ')}`;
      if (meta?.pattern && !new RegExp(meta.pattern).test(value)) return meta.patternHint ? `Expected ${meta.patternHint}` : 'Value has the wrong format';
      return null;
    }
    case 'json':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'This setting expects a JSON object';
      return meta?.validate?.(value) ?? null;
  }
}

export function describeSetting(key: string) {
  const meta = SETTING_META[key];
  const group = meta?.group ?? key.split('.')[0] ?? 'platform';
  return {
    ...(meta ?? null),
    group,
    groupLabel: SETTING_GROUPS[group]?.label ?? group.charAt(0).toUpperCase() + group.slice(1),
    groupDescription: SETTING_GROUPS[group]?.description ?? null,
    known: !!meta,
  };
}

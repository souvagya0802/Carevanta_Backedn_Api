/**
 * Metadata for platform settings: how each key is labelled, grouped, typed and
 * bounded. The database row is the source of truth for the *value*; this
 * registry is the source of truth for *what a valid value is* and how the admin
 * UI should present it. Keys without metadata are still editable (type-checked
 * only), so adding a setting never requires a dashboard release.
 */
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
}

export const SETTING_GROUPS: Record<string, { label: string; description: string }> = {
  booking: { label: 'Appointments', description: 'How bookings are confirmed and cancelled.' },
  finance: { label: 'Finance', description: 'Commission and settlement timing.' },
  emergency: { label: 'Emergency', description: 'Ambulance dispatch and the public emergency number.' },
  search: { label: 'Discovery', description: 'How patients find providers.' },
  platform: { label: 'Platform', description: 'General platform behaviour.' },
};

export const SETTING_META: Record<string, SettingMeta> = {
  'booking.patient_cancellation_cutoff_minutes': { label: 'Free cancellation cut-off', group: 'booking', type: 'integer', unit: 'minutes before the slot', min: 0, max: 10080, step: 15, risk: 'medium', default: 120, help: 'Cancellations inside this window may attract the provider’s cancellation policy. 0 disables the cut-off.' },
  'booking.require_provider_confirmation': { label: 'Provider confirmation required', group: 'booking', type: 'boolean', risk: 'medium', default: true, help: 'On: new appointments wait as REQUESTED until the provider confirms. Off: they are confirmed instantly when a slot is free.' },
  'finance.settlement_hold_days': { label: 'Settlement hold period', group: 'finance', type: 'integer', unit: 'days after completion', min: 0, max: 90, step: 1, risk: 'high', default: 7, help: 'Earnings become settleable only after this many days, giving time for refunds and disputes. Shortening it increases refund exposure.' },
  'finance.commission_on_provider_direct': { label: 'Commission on walk-in bookings', group: 'finance', type: 'boolean', risk: 'high', default: false, help: 'Walk-in (PROVIDER_DIRECT) bookings are recorded by the provider themselves. Charging commission on them needs explicit contractual backing.' },
  'emergency.public_number': { label: 'Public emergency number', group: 'emergency', type: 'string', pattern: '^[0-9]{2,6}$', patternHint: '2–6 digits', risk: 'high', default: '112', help: 'Shown first on every emergency screen before any in-app dispatch. In India this is 112.' },
  'emergency.live_dispatch_enabled': { label: 'Live ambulance dispatch', group: 'emergency', type: 'boolean', risk: 'high', default: false, help: 'When on, emergency requests are sent to real partner operators. Enable only with signed operator agreements, a tested escalation rota and completed drills.' },
  'search.default_radius_km': { label: 'Default search radius', group: 'search', type: 'integer', unit: 'km', min: 1, max: 200, step: 1, risk: 'low', default: 15, help: 'Used when a patient searches without choosing a distance.' },
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
      if (value === null || typeof value !== 'object') return 'This setting expects a JSON object';
      return null;
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

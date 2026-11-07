/**
 * What the super-admin can configure about the provider portal without a
 * release: section names, page titles and subtitles per provider type, which
 * pages a provider type sees, the words used for an organisation ("practice",
 * "chamber"), an announcement banner, support contacts, and which capabilities
 * each staff role carries.
 *
 * Two platform settings hold this:
 *   portal.ui                  – copy, structure, banner, support contacts
 *   portal.member_capabilities – role → capabilities for provider staff
 *
 * The portal app keeps its own defaults, so an empty setting means "as shipped".
 * Owners always hold every capability; that cannot be configured away.
 */
import { z } from 'zod';
import { PROVIDER_MEMBER_CAPABILITIES, type ProviderCapability } from '../access/permissions.js';
import { getSetting } from '../settings/settings.service.js';

export const PORTAL_TYPES = ['DOCTOR', 'HOSPITAL', 'CLINIC', 'DIAGNOSTIC_LAB', 'IMAGING_CENTRE', 'PHARMACY', 'AMBULANCE_OPERATOR'] as const;
export type PortalType = (typeof PORTAL_TYPES)[number];

const FACILITIES: PortalType[] = ['HOSPITAL', 'CLINIC'];
const DIAGNOSTICS: PortalType[] = ['DIAGNOSTIC_LAB', 'IMAGING_CENTRE'];

/** Every page in the portal, with the provider types it applies to (empty = all). Mirrors the portal's navigation. */
export const PORTAL_PAGES: { href: string; label: string; group: string; types: PortalType[]; capabilities: string[] }[] = [
  { href: '/', label: 'Home', group: 'Overview', types: [], capabilities: [] },
  { href: '/analytics', label: 'Analytics', group: 'Overview', types: [], capabilities: [] },
  { href: '/verification', label: 'Verification', group: 'Overview', types: [], capabilities: [] },
  { href: '/appointments', label: 'Appointments', group: 'Day to Day', types: ['DOCTOR', ...FACILITIES], capabilities: ['manage_bookings'] },
  { href: '/schedules', label: 'Schedules & Slots', group: 'Day to Day', types: ['DOCTOR', ...FACILITIES], capabilities: ['manage_schedules'] },
  { href: '/diagnostic-orders', label: 'Orders & Reports', group: 'Day to Day', types: DIAGNOSTICS, capabilities: ['manage_bookings', 'publish_reports'] },
  { href: '/pharmacy-orders', label: 'Orders', group: 'Day to Day', types: ['PHARMACY'], capabilities: ['manage_bookings'] },
  { href: '/prescriptions', label: 'Prescriptions', group: 'Day to Day', types: ['PHARMACY'], capabilities: ['review_prescriptions'] },
  { href: '/inventory', label: 'Stock', group: 'Day to Day', types: ['PHARMACY'], capabilities: ['manage_inventory'] },
  { href: '/dispatch', label: 'Dispatch', group: 'Day to Day', types: ['AMBULANCE_OPERATOR'], capabilities: ['manage_dispatch'] },
  { href: '/fleet', label: 'Vehicles & Crew', group: 'Day to Day', types: ['AMBULANCE_OPERATOR'], capabilities: [] },
  { href: '/profile', label: 'Profile', group: 'Organisation', types: [], capabilities: [] },
  { href: '/locations', label: 'Locations & Hours', group: 'Organisation', types: [], capabilities: [] },
  { href: '/services', label: 'Services & Prices', group: 'Organisation', types: [...FACILITIES, ...DIAGNOSTICS], capabilities: [] },
  { href: '/affiliations', label: 'Doctors / Hospitals & Clinics', group: 'Organisation', types: ['DOCTOR', ...FACILITIES], capabilities: ['manage_affiliations'] },
  { href: '/documents', label: 'Documents', group: 'Organisation', types: [], capabilities: [] },
  { href: '/staff', label: 'Staff', group: 'Organisation', types: [], capabilities: ['manage_staff'] },
  { href: '/finance', label: 'Earnings & Payouts', group: 'Money', types: [], capabilities: ['view_finance'] },
  { href: '/notifications', label: 'Notifications', group: 'Account', types: [], capabilities: [] },
  { href: '/account/password', label: 'Account', group: 'Account', types: [], capabilities: [] },
];
const PAGE_HREFS = new Set(PORTAL_PAGES.map((p) => p.href));

/** Default words per provider type, as shipped in the portal. */
export const DEFAULT_WORDS: Record<PortalType, { noun: string; locationNoun: string; locationsTitle: string }> = {
  DOCTOR: { noun: 'practice', locationNoun: 'chamber', locationsTitle: 'Practice Locations' },
  HOSPITAL: { noun: 'hospital', locationNoun: 'branch', locationsTitle: 'Campus & Branches' },
  CLINIC: { noun: 'clinic', locationNoun: 'branch', locationsTitle: 'Clinic Locations' },
  DIAGNOSTIC_LAB: { noun: 'laboratory', locationNoun: 'centre', locationsTitle: 'Laboratory & Collection Centres' },
  IMAGING_CENTRE: { noun: 'imaging centre', locationNoun: 'centre', locationsTitle: 'Imaging Centres' },
  PHARMACY: { noun: 'pharmacy', locationNoun: 'store', locationsTitle: 'Store Locations' },
  AMBULANCE_OPERATOR: { noun: 'ambulance service', locationNoun: 'base station', locationsTitle: 'Base Stations' },
};

const Text = (max: number) => z.string().trim().min(1).max(max);
const Words = z.object({ noun: Text(40).optional(), locationNoun: Text(40).optional(), locationsTitle: Text(60).optional() }).strict();
const NavOverride = z.object({ label: Text(40).optional(), hidden: z.boolean().optional() }).strict();
const PageOverride = z.object({ title: Text(80).optional(), description: z.string().trim().max(300).optional() }).strict();
const TypeConfig = z
  .object({ words: Words.optional(), nav: z.record(z.string(), NavOverride).optional(), pages: z.record(z.string(), PageOverride).optional() })
  .strict()
  .superRefine((t, ctx) => {
    for (const href of Object.keys(t.nav ?? {})) {
      if (!PAGE_HREFS.has(href)) ctx.addIssue({ code: 'custom', message: `Unknown page "${href}"`, path: ['nav', href] });
      if (href === '/' && t.nav?.[href]?.hidden) ctx.addIssue({ code: 'custom', message: 'Home cannot be hidden', path: ['nav', href] });
    }
    for (const href of Object.keys(t.pages ?? {})) if (!PAGE_HREFS.has(href)) ctx.addIssue({ code: 'custom', message: `Unknown page "${href}"`, path: ['pages', href] });
  });

export const PortalUiSchema = z
  .object({
    announcement: z
      .object({ text: Text(300), tone: z.enum(['info', 'warning', 'success']).default('info'), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(), link: z.string().url().max(300).optional() })
      .strict()
      .nullable()
      .optional(),
    support: z.object({ email: z.email().max(254).optional(), phone: z.string().trim().regex(/^\+?[0-9 ]{8,16}$/, 'Phone number').optional(), helpUrl: z.string().url().max(300).optional(), hours: z.string().trim().max(80).optional() }).strict().optional(),
    types: z.partialRecord(z.enum(PORTAL_TYPES), TypeConfig).optional(),
  })
  .strict();
export type PortalUi = z.infer<typeof PortalUiSchema>;

export const ALL_CAPABILITIES = PROVIDER_MEMBER_CAPABILITIES.OWNER as readonly ProviderCapability[];
export const CONFIGURABLE_ROLES = ['ADMIN', 'STAFF', 'PHARMACIST', 'LAB_TECHNICIAN', 'DISPATCHER'] as const;
export const MemberCapabilitiesSchema = z.partialRecord(z.enum(CONFIGURABLE_ROLES), z.array(z.enum(ALL_CAPABILITIES as unknown as [ProviderCapability, ...ProviderCapability[]])).max(ALL_CAPABILITIES.length));
export type MemberCapabilities = z.infer<typeof MemberCapabilitiesSchema>;

/** The matrix as shipped (owners excluded: they always hold everything). */
export const DEFAULT_MEMBER_CAPABILITIES: Required<MemberCapabilities> = {
  ADMIN: [...PROVIDER_MEMBER_CAPABILITIES.ADMIN],
  STAFF: [...PROVIDER_MEMBER_CAPABILITIES.STAFF],
  PHARMACIST: [...PROVIDER_MEMBER_CAPABILITIES.PHARMACIST],
  LAB_TECHNICIAN: [...PROVIDER_MEMBER_CAPABILITIES.LAB_TECHNICIAN],
  DISPATCHER: [...PROVIDER_MEMBER_CAPABILITIES.DISPATCHER],
};

/** Human-readable problem with a candidate `portal.ui` value, or null. */
export function validatePortalUi(value: unknown): string | null {
  const r = PortalUiSchema.safeParse(value);
  return r.success ? null : r.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).slice(0, 3).join('; ');
}
export function validateMemberCapabilities(value: unknown): string | null {
  const r = MemberCapabilitiesSchema.safeParse(value);
  if (!r.success) return r.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.') || 'value'}: ${i.message}`).slice(0, 3).join('; ');
  if ('OWNER' in (value as object)) return 'Owners always hold every capability and cannot be configured';
  return null;
}

/** Effective capabilities per role: the shipped matrix with the super-admin's overrides applied. */
export async function memberCapabilityMatrix(): Promise<Record<string, readonly ProviderCapability[]>> {
  const raw = await getSetting<unknown>('portal.member_capabilities', {});
  const parsed = MemberCapabilitiesSchema.safeParse(raw);
  const override = parsed.success ? parsed.data : {};
  return { OWNER: ALL_CAPABILITIES, ...DEFAULT_MEMBER_CAPABILITIES, ...override };
}

export async function capabilitiesForRole(role: string): Promise<readonly ProviderCapability[]> {
  const matrix = await memberCapabilityMatrix();
  return matrix[role] ?? [];
}

/** The `portal.ui` setting, parsed; an invalid stored value falls back to "as shipped" rather than breaking the portal. */
export async function portalUi(): Promise<PortalUi> {
  const raw = await getSetting<unknown>('portal.ui', {});
  const parsed = PortalUiSchema.safeParse(raw);
  const ui = parsed.success ? parsed.data : {};
  // An expired announcement is simply not shown.
  if (ui.announcement?.until && ui.announcement.until < new Date().toISOString().slice(0, 10)) return { ...ui, announcement: null };
  return ui;
}

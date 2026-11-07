/**
 * Content of the patient app that the super-admin edits without a release:
 * the home hero (title, subtitle, image, button), the landing page that
 * explains what Carevanta is, highlight tiles, the category shortcuts, an
 * announcement banner, support contacts and the two theme colours.
 *
 * Stored as the `patient.ui` platform setting (JSON) plus `patient.hero_image`
 * (an uploaded image, served publicly). Empty means "as shipped": the app has
 * sensible defaults so a fresh platform never shows a blank home screen.
 */
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { getSetting } from '../settings/settings.service.js';

const Text = (max: number) => z.string().trim().min(1).max(max);
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Hex colour like #0D9488');
const Icon = z.enum(['stethoscope', 'flask', 'pill', 'ambulance', 'hospital', 'heart', 'shield', 'clock', 'map', 'star', 'phone', 'file', 'home', 'baby', 'eye', 'tooth', 'bone', 'brain']);

export const PatientUiSchema = z
  .object({
    hero: z.object({ badge: Text(40).optional(), title: Text(90).optional(), subtitle: Text(200).optional(), ctaLabel: Text(30).optional(), ctaHref: z.string().regex(/^\/[a-z0-9\-/?=&]*$/i).max(120).optional(), secondaryLabel: Text(30).optional(), secondaryHref: z.string().regex(/^\/[a-z0-9\-/?=&]*$/i).max(120).optional() }).strict().optional(),
    highlights: z.array(z.object({ icon: Icon, title: Text(40), text: Text(120) }).strict()).max(6).optional(),
    categories: z.array(z.object({ key: Text(40), label: Text(30), icon: Icon, href: z.string().regex(/^\/[a-z0-9\-/?=&]*$/i).max(120), colour: Hex.optional(), enabled: z.boolean().default(true) }).strict()).max(12).optional(),
    landing: z.object({ headline: Text(90).optional(), subheadline: Text(240).optional(), points: z.array(Text(120)).max(8).optional(), stats: z.array(z.object({ label: Text(30), value: Text(20) }).strict()).max(4).optional(), footerNote: Text(240).optional() }).strict().optional(),
    announcement: z.object({ text: Text(240), tone: z.enum(['info', 'warning', 'success']).default('info'), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), link: z.string().url().max(300).optional() }).strict().nullable().optional(),
    support: z.object({ phone: z.string().trim().regex(/^\+?[0-9 ]{8,16}$/).optional(), whatsapp: z.string().trim().regex(/^\+?[0-9]{8,15}$/).optional(), email: z.email().max(254).optional(), hours: Text(80).optional() }).strict().optional(),
    theme: z.object({ primary: Hex.optional(), accent: Hex.optional() }).strict().optional(),
    /** Quick chips under the search box, in the words patients use ("Fever", "Child doctor"). */
    popularSearches: z.array(Text(40)).max(12).optional(),
  })
  .strict();
export type PatientUi = z.infer<typeof PatientUiSchema>;

/** As shipped. Everything here can be overridden from Settings → Patient App. */
export const PATIENT_UI_DEFAULTS = {
  hero: { badge: 'Trusted care near you', title: 'Find the right doctor, test or medicine in minutes', subtitle: 'Verified doctors, labs, pharmacies and ambulances across Purba Medinipur. Book, pay and keep every report in one place.', ctaLabel: 'Find a Doctor', ctaHref: '/search?type=doctors', secondaryLabel: 'Book a Lab Test', secondaryHref: '/tests' },
  highlights: [
    { icon: 'shield', title: 'Verified Providers', text: 'Every doctor, lab and pharmacy is checked against official registries before listing.' },
    { icon: 'clock', title: 'Real Slots', text: 'See live availability and book a confirmed time — no call-backs.' },
    { icon: 'file', title: 'Reports in Your Pocket', text: 'Lab reports and prescriptions stay with you, shareable with any doctor.' },
    { icon: 'ambulance', title: 'Emergency Help', text: 'One tap shows 112 first, then reaches verified ambulances near you.' },
  ],
  categories: [
    { key: 'doctors', label: 'Doctors', icon: 'stethoscope', href: '/search?type=doctors', colour: '#1E6CFF', enabled: true },
    { key: 'hospitals', label: 'Hospitals', icon: 'hospital', href: '/search?type=facilities', colour: '#2563EB', enabled: true },
    { key: 'labs', label: 'Lab Tests', icon: 'flask', href: '/tests', colour: '#7C3AED', enabled: true },
    { key: 'pharmacy', label: 'Medicines', icon: 'pill', href: '/pharmacy', colour: '#F59E0B', enabled: true },
    { key: 'ambulance', label: 'Ambulance', icon: 'ambulance', href: '/emergency', colour: '#E11D48', enabled: true },
    { key: 'records', label: 'My Records', icon: 'file', href: '/records', colour: '#0EA5E9', enabled: true },
  ],
  landing: {
    headline: 'Healthcare for your family, all in one app',
    subheadline: 'Carevanta connects you with verified doctors, hospitals, diagnostic labs, pharmacies and ambulance services around you — so care is one tap away, not one queue away.',
    points: ['Book doctors by speciality or by what you feel', 'Home sample collection and reports on your phone', 'Medicines with prescription checks by a real pharmacist', 'Emergency help that puts 112 first, always'],
    stats: [{ label: 'Verified doctors', value: '30+' }, { label: 'Lab tests', value: '100+' }, { label: 'Pilot district', value: 'Purba Medinipur' }],
    footerNote: 'Carevanta is a marketplace that connects patients with independent, licensed healthcare providers. In an emergency, call 112 first.',
  },
  announcement: null as PatientUi['announcement'],
  support: { phone: undefined as string | undefined, whatsapp: undefined as string | undefined, email: undefined as string | undefined, hours: undefined as string | undefined },
  theme: { primary: '#1E6CFF', accent: '#12C2E9' },
  popularSearches: ['Fever', 'Stomach pain', 'Child doctor', 'Sugar test', 'Skin doctor', 'Back pain', 'Cold and cough', 'Eye doctor'],
};

export function validatePatientUi(value: unknown): string | null {
  const r = PatientUiSchema.safeParse(value);
  return r.success ? null : r.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.') || 'value'}: ${i.message}`).slice(0, 3).join('; ');
}

export interface HeroImage { storageKey: string; mimeType: string; sha256: string }

/** Effective content: defaults overlaid with whatever the super-admin set. */
export async function patientUi() {
  const [raw, emergencyNumber, hero] = await Promise.all([
    getSetting<unknown>('patient.ui', {}),
    getSetting<string>('emergency.public_number', '112'),
    getSetting<HeroImage | null>('patient.hero_image', null),
  ]);
  const parsed = PatientUiSchema.safeParse(raw);
  const o: PatientUi = parsed.success ? parsed.data : {};
  const d = PATIENT_UI_DEFAULTS;
  const announcement = o.announcement === undefined ? d.announcement : o.announcement;
  return {
    hero: { ...d.hero, ...o.hero },
    heroImageUrl: hero?.storageKey ? `/api/v1/public/patient-ui/hero?v=${hero.sha256.slice(0, 12)}` : null,
    highlights: o.highlights?.length ? o.highlights : d.highlights,
    categories: (o.categories?.length ? o.categories : d.categories).filter((c) => c.enabled !== false),
    landing: { ...d.landing, ...o.landing },
    announcement: announcement && announcement.until && announcement.until < new Date().toISOString().slice(0, 10) ? null : announcement,
    support: { ...d.support, ...o.support },
    theme: { ...d.theme, ...o.theme },
    popularSearches: o.popularSearches?.length ? o.popularSearches : d.popularSearches,
    emergencyNumber,
  };
}

/** The raw stored override (for the admin editor) plus the defaults to show as placeholders. */
export async function patientUiAdminView() {
  const row = await prisma.platformSetting.findUnique({ where: { key: 'patient.ui' } });
  return { value: (row?.value as PatientUi | null) ?? {}, version: row?.version ?? 0, defaults: PATIENT_UI_DEFAULTS, effective: await patientUi() };
}

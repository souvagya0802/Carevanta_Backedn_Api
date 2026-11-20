/**
 * Public URL of a medicine's photo, or null when it has none. The `v` query is
 * the start of the image hash, so the browser and CDN cache it for a long time
 * and a new photo gets a new URL. Every API response that returns a medicine
 * uses this, so the patient app, provider portal and super admin all agree.
 */
export function medicineImageUrl(m: { id: string; imageSha256?: string | null }): string | null {
  return m.imageSha256 ? `/api/v1/public/catalogue/medicines/${m.id}/image?v=${m.imageSha256.slice(0, 12)}` : null;
}

/** Credit for an openly licensed web photo (CC BY needs it shown); all null/false when there is no photo. */
export function medicineImageCredit(m: { imageSha256?: string | null; imageCredit?: string | null; imageLicence?: string | null; imageSourceUrl?: string | null; imageIsRepresentative?: boolean | null }) {
  const has = !!m.imageSha256;
  return { imageCredit: has ? (m.imageCredit ?? null) : null, imageLicence: has ? (m.imageLicence ?? null) : null, imageSourceUrl: has ? (m.imageSourceUrl ?? null) : null, imageIsRepresentative: has ? !!m.imageIsRepresentative : false };
}

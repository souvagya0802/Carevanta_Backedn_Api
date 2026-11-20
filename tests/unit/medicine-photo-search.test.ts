import { afterEach, describe, expect, it } from 'vitest';
import { allowedLicence, allowedPhotoHost, mergeCandidates, searchOpenImages, setPhotoSearchFetch, type PhotoCandidate } from '../../src/modules/catalogue/medicine-photo-search.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ov = (id: string, license: string, version = '4.0', url = `https://live.staticflickr.com/1/${id}.jpg`) => ({ id, title: `Photo ${id}`, url, thumbnail: `https://api.openverse.org/v1/images/${id}/thumb/`, license, license_version: version, creator: 'Synthetic Creator', foreign_landing_url: `https://www.flickr.com/photos/x/${id}`, mime_type: 'image/jpeg', width: 800, height: 600 });

afterEach(() => setPhotoSearchFetch(null));

describe('licence allowlist', () => {
  it('keeps commercial, derivative-friendly licences and refuses NC and ND', () => {
    expect(allowedLicence('by', '4.0')).toBe('CC BY 4.0');
    expect(allowedLicence('by-sa', '3.0')).toBe('CC BY-SA 3.0');
    expect(allowedLicence('CC BY-SA 4.0')).toBe('CC BY-SA 4.0');
    expect(allowedLicence('cc0', '1.0')).toBe('CC0');
    expect(allowedLicence('pdm')).toBe('Public Domain');
    expect(allowedLicence('Public domain')).toBe('Public Domain');
    for (const bad of ['by-nc', 'by-nd', 'by-nc-sa', 'CC BY-NC 4.0', 'CC BY-ND 2.0', 'by-sa 2.5', 'GFDL', '', null]) expect(allowedLicence(bad as string, '4.0')).toBeNull();
    expect(allowedLicence('by', '1.0')).toBeNull();
  });

  it('allows only the fixed photo hosts plus named extras', () => {
    expect(allowedPhotoHost('upload.wikimedia.org')).toBe(true);
    expect(allowedPhotoHost('farm1.staticflickr.com')).toBe(true);
    expect(allowedPhotoHost('evil.example.com')).toBe(false);
    expect(allowedPhotoHost('staticflickr.com.evil.net')).toBe(false);
    expect(allowedPhotoHost('cdn.example.org', ['cdn.example.org'])).toBe(true);
  });
});

describe('merge and fallback', () => {
  it('drops duplicates by id, url and file name', () => {
    const c = (p: Partial<PhotoCandidate>): PhotoCandidate => ({ provider: 'openverse', id: '1', title: 't', thumbUrl: 'https://a/t', fullUrl: 'https://a/file-abc.jpg', width: 1, height: 1, mime: 'image/jpeg', licence: 'CC BY 4.0', licenceUrl: null, creator: null, sourcePageUrl: 'https://a/p1', attribution: 'x', matchedOn: 'brand', ...p });
    const out = mergeCandidates([[c({}), c({ id: '2', fullUrl: 'https://b/file-abc.jpg', sourcePageUrl: 'https://b/p' })], [c({ provider: 'commons', id: '9', fullUrl: 'https://c/other.jpg', sourcePageUrl: 'https://c/p' })]]);
    expect(out.map((x) => x.id)).toEqual(['1', '9']);
  });

  it('searches the brand first, then the salt with the dosage form, filtering licences and types', async () => {
    const urls: string[] = [];
    setPhotoSearchFetch(async (url) => {
      urls.push(url);
      if (url.includes('openverse')) {
        if (url.includes('Brandox')) return json({ results: [ov('b1', 'by-nc'), { ...ov('b2', 'by'), mime_type: 'image/gif' }] });
        return json({ results: [ov('s1', 'by'), ov('s2', 'by-sa', '3.0'), ov('s3', 'by-nd')] });
      }
      return json({ query: { pages: {} } });
    });
    const res = await searchOpenImages({ brand: 'Brandox', strength: '500 mg', composition: 'Azithromycin (500 mg)', dosageForm: 'Tablet' });
    expect(res.queries).toEqual(['Brandox 500 mg', 'Azithromycin Tablet']);
    expect(res.candidates.map((c) => [c.id, c.licence, c.matchedOn])).toEqual([['s1', 'CC BY 4.0', 'composition'], ['s2', 'CC BY-SA 3.0', 'composition']]);
    expect(res.exhausted).toBe(false);
    expect(urls.filter((u) => u.includes('openverse')).length).toBe(2);
  });

  it('flags an upstream 429 as exhausted', async () => {
    setPhotoSearchFetch(async () => json({ detail: 'throttled' }, 429));
    const res = await searchOpenImages({ brand: 'Limitol' });
    expect(res.exhausted).toBe(true);
    expect(res.candidates).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_REMINDER_LEAD_HOURS, dueLead, hoursUntil, parseLeadHours, reminderLabel } from '../../src/jobs/reminders.js';

const H = 3_600_000;
const start = new Date('2026-11-20T04:30:00.000Z'); // 10:00 IST

describe('reminder lead times', () => {
  it('parses the admin setting, dedupes, sorts largest first and drops junk', () => {
    expect(parseLeadHours('24,2')).toEqual([24, 2]);
    expect(parseLeadHours(' 2 , 24 , 24 ')).toEqual([24, 2]);
    expect(parseLeadHours([48, 24, 2])).toEqual([48, 24, 2]);
    expect(parseLeadHours('0,-3,abc,500')).toEqual([...DEFAULT_REMINDER_LEAD_HOURS]);
    expect(parseLeadHours('')).toEqual([24, 2]);
    expect(parseLeadHours(undefined)).toEqual([24, 2]);
    expect(parseLeadHours(6)).toEqual([6]);
    expect(reminderLabel(24)).toBe('24h');
  });

  it('picks exactly one window: 24 h between 2 and 24 hours out, 2 h inside the last two hours', () => {
    const leads = [24, 2];
    expect(dueLead(start, new Date(start.getTime() - 30 * H), leads)).toBeNull(); // not yet
    expect(dueLead(start, new Date(start.getTime() - 24 * H), leads)).toBe(24); // boundary inclusive
    expect(dueLead(start, new Date(start.getTime() - 23 * H), leads)).toBe(24);
    expect(dueLead(start, new Date(start.getTime() - 2 * H - 1), leads)).toBe(24);
    expect(dueLead(start, new Date(start.getTime() - 2 * H), leads)).toBe(2);
    expect(dueLead(start, new Date(start.getTime() - 90 * 60_000), leads)).toBe(2); // booked late: only the 2 h one
    expect(dueLead(start, new Date(start.getTime() - 1), leads)).toBe(2);
    expect(dueLead(start, start, leads)).toBeNull(); // started
    expect(dueLead(start, new Date(start.getTime() + H), leads)).toBeNull(); // in the past
  });

  it('works with a single lead time and unsorted input', () => {
    expect(dueLead(start, new Date(start.getTime() - 5 * H), [6])).toBe(6);
    expect(dueLead(start, new Date(start.getTime() - 7 * H), [6])).toBeNull();
    expect(dueLead(start, new Date(start.getTime() - 10 * H), [2, 24])).toBe(24);
  });

  it('reports whole hours until the booking, never below one', () => {
    expect(hoursUntil(start, new Date(start.getTime() - 23 * H - 20 * 60_000))).toBe(23);
    expect(hoursUntil(start, new Date(start.getTime() - 110 * 60_000))).toBe(2);
    expect(hoursUntil(start, new Date(start.getTime() - 10 * 60_000))).toBe(1);
  });
});

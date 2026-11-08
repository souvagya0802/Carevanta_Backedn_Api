import { afterEach, describe, expect, it } from 'vitest';
import { noticeFields } from '../../src/modules/notifications/events.js';
import { handleChange, MAX_STREAMS_PER_USER, openStreamCount, stopNotificationStreams, subscribe, toStreamNotification, type StreamEvent } from '../../src/modules/notifications/stream.js';

type Change = Parameters<typeof handleChange>[0];
const insert = (doc: Record<string, unknown>) => ({ operationType: 'insert', fullDocument: doc, documentKey: { _id: doc._id } }) as unknown as Change;
const readUpdate = (doc: Record<string, unknown>) => ({ operationType: 'update', fullDocument: doc, documentKey: { _id: doc._id }, updateDescription: { updatedFields: { read_at: new Date() } } }) as unknown as Change;

describe('notification levels and stream routing', () => {
  afterEach(() => stopNotificationStreams());

  it('derives level and meta from the stored payload, tolerating rows written before levels existed', () => {
    expect(noticeFields({ level: 'critical', meta: { kind: 'dispatch', id: 'd1', status: 'ACCEPTED' } })).toEqual({ level: 'critical', meta: { kind: 'dispatch', id: 'd1', status: 'ACCEPTED' } });
    expect(noticeFields({ urgent: true })).toEqual({ level: 'important', meta: null });
    expect(noticeFields({})).toEqual({ level: 'light', meta: null });
    expect(noticeFields({ level: 'loud', meta: { kind: 'x' } })).toEqual({ level: 'light', meta: null });
  });

  it('routes inserts and read-marks only to the user they concern', () => {
    const a: StreamEvent[] = [];
    const b: StreamEvent[] = [];
    const offA = subscribe('user-a', (e) => a.push(e));
    const offB = subscribe('user-b', (e) => b.push(e));
    handleChange(insert({ _id: 'n1', user_id: 'user-a', channel: 'IN_APP', template_key: 'portal.appointment_booked', payload: { level: 'important', meta: { kind: 'appointment', id: 'ap1' } }, title: 'New appointment request', body: 'x', link: '/appointments?id=ap1', created_at: new Date('2026-11-08T10:00:00Z') }));
    handleChange(insert({ _id: 'n2', user_id: 'user-a', channel: 'PUSH', template_key: 'portal.appointment_booked', payload: {} })); // push rows are not streamed
    handleChange(readUpdate({ _id: 'n1', user_id: 'user-a', channel: 'IN_APP' }));
    expect(a.map((e) => e.event)).toEqual(['notification', 'read']);
    expect(a[0]).toMatchObject({ event: 'notification', data: { id: 'n1', templateKey: 'portal.appointment_booked', level: 'important', meta: { kind: 'appointment', id: 'ap1' }, link: '/appointments?id=ap1', createdAt: '2026-11-08T10:00:00.000Z' } });
    expect(a[1]).toEqual({ event: 'read', data: { ids: ['n1'] } });
    expect(b).toEqual([]);
    offA();
    offB();
    expect(openStreamCount()).toBe(0);
  });

  it('caps open streams per user and frees the slot on unsubscribe', () => {
    const offs = Array.from({ length: MAX_STREAMS_PER_USER }, () => subscribe('user-c', () => undefined));
    expect(() => subscribe('user-c', () => undefined)).toThrow(/open notification streams/);
    offs[0]!();
    expect(() => subscribe('user-c', () => undefined)).not.toThrow();
    expect(toStreamNotification({ _id: 'n9', template_key: 'k', payload: null })).toMatchObject({ id: 'n9', level: 'light', meta: null, title: null });
  });
});

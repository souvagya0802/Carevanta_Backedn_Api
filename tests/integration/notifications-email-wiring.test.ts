import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { decryptNotificationPayload } from '../../src/modules/notifications/notifications.service.js';
import { act, book, reschedule } from '../../src/modules/appointments/appointments.service.js';
import { diagnosticAction } from '../../src/modules/diagnostics/diagnostics.routes.js';
import { advancePharmacyOrder } from '../../src/modules/pharmacy/pharmacy.routes.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, idem } from '../helpers/factory.js';
import { affiliatedDoctor, patient, randomUUID, slotsFor } from '../helpers/fixtures.js';

const V = '/api/v1';
beforeAll(resetDatabase);

/** EMAIL outbox rows for one template key and user, with decrypted payloads. */
async function emails(templateKey: string, userId: string) {
  const rows = await prisma.notification.findMany({ where: { channel: 'EMAIL', templateKey, userId } });
  return rows.map((r) => ({ recipient: r.recipient, payload: decryptNotificationPayload(r.payload) }));
}

async function bookedSetup(capacity = 4) {
  const ctx = await affiliatedDoctor();
  const { slots } = await slotsFor(ctx.hospitalOwner, ctx.doctor.id, ctx.hospital.locationId, { capacity });
  const p = await patient();
  const book = async (slotIdx = 0) => {
    const b = await p.post(`${V}/patient/appointments`, { slotId: slots[slotIdx]!.id, patientProfileId: p.profileId }, idem());
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    return b.body.data.id as string;
  };
  const doctorName = (await prisma.provider.findUniqueOrThrow({ where: { id: ctx.doctor.id } })).displayName;
  return { ...ctx, slots, p, book, doctorName };
}

async function orderProvider(type: 'DIAGNOSTIC_LAB' | 'IMAGING_CENTRE' | 'PHARMACY') {
  return prisma.provider.create({ data: { type, status: 'APPROVED', legalName: `Synthetic ${type}`, displayName: `Synthetic ${type}`, slug: `syn-${randomUUID()}` } });
}
const orderBase = (patientProfileId: string, bookedByUserId: string, providerId: string) => ({
  reference: `ORD-${randomUUID().slice(0, 8)}`, patientProfileId, bookedByUserId, providerId, source: 'PATIENT_APP' as const, attribution: 'PLATFORM' as const, totalMinor: 50000n,
});

describe('email wiring for important events', () => {
  it('emails staff who manage bookings about a new request, but not the patient and not staff who booked it themselves', async () => {
    const s = await bookedSetup();
    const id = await s.book();
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id } });
    const staffMail = await emails('booking.requested', s.hospitalOwner.user.id);
    expect(staffMail).toHaveLength(1);
    expect(staffMail[0]!.recipient).toBe(s.hospitalOwner.user.email);
    expect(staffMail[0]!.payload).toMatchObject({ patientName: 'Synthetic Patient', reference: appt.reference, doctorName: s.doctorName });
    expect(typeof staffMail[0]!.payload.when).toBe('string');
    expect(await emails('booking.requested', s.p.user.id)).toHaveLength(0);

    // Staff booking on the patient's behalf: the staff member is the actor and is not emailed.
    const byStaff = await book({ slotId: s.slots[1]!.id, patientProfileId: s.p.profileId, bookedByUserId: s.hospitalOwner.user.id, source: 'PROVIDER_PORTAL', attribution: 'PROVIDER_DIRECT', payAtProvider: true, actorKind: 'PROVIDER' });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: byStaff } })).status).toBe('REQUESTED');
    expect(await emails('booking.requested', s.hospitalOwner.user.id)).toHaveLength(1);
  });

  it('emails the patient when the booking is confirmed or cancelled by the clinic (SMS kept), not when the patient cancels', async () => {
    const s = await bookedSetup();
    await prisma.user.update({ where: { id: s.p.user.id }, data: { phone: '9800011111' } });
    const id = await s.book();
    await act(id, 'CONFIRM', { userId: s.hospitalOwner.user.id, kind: 'PROVIDER' });
    const confirmed = await emails('booking.confirmed', s.p.user.id);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.recipient).toBe(s.p.user.email);
    expect(confirmed[0]!.payload).toMatchObject({ doctorName: s.doctorName });
    expect(await prisma.notification.count({ where: { channel: 'SMS', templateKey: 'booking.confirmed', userId: s.p.user.id } })).toBe(1);
    expect(await emails('booking.confirmed', s.hospitalOwner.user.id)).toHaveLength(0);

    await act(id, 'CANCEL', { userId: s.hospitalOwner.user.id, kind: 'PROVIDER' }, 'Doctor on leave');
    expect(await emails('booking.cancelled', s.p.user.id)).toHaveLength(1);

    const own = await s.book(1);
    await act(own, 'CANCEL', { userId: s.p.user.id, kind: 'PATIENT' });
    expect(await emails('booking.cancelled', s.p.user.id)).toHaveLength(1); // still only the clinic's cancellation
    expect(await prisma.notification.count({ where: { channel: 'SMS', templateKey: 'booking.cancelled', userId: s.p.user.id } })).toBe(2);
  });

  it('emails the patient when someone else reschedules, not when the patient does', async () => {
    const s = await bookedSetup();
    const ops = await actor(['SUPER_ADMIN']);
    const id = await s.book();
    const newId = await reschedule(id, s.slots[1]!.id, { userId: ops.user.id, kind: 'PLATFORM' });
    const moved = await prisma.appointment.findUniqueOrThrow({ where: { id: newId } });
    const mail = await emails('booking.rescheduled', s.p.user.id);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.payload).toMatchObject({ reference: moved.reference, doctorName: s.doctorName });
    expect(await emails('booking.rescheduled', ops.user.id)).toHaveLength(0);

    await reschedule(newId, s.slots[2]!.id, { userId: s.p.user.id, kind: 'PATIENT' });
    expect(await emails('booking.rescheduled', s.p.user.id)).toHaveLength(1);
  });

  it('skips the email silently when the patient has no email address', async () => {
    const s = await bookedSetup();
    await prisma.user.update({ where: { id: s.p.user.id }, data: { email: null } });
    const id = await s.book();
    await act(id, 'CONFIRM', { userId: s.hospitalOwner.user.id, kind: 'PROVIDER' });
    await act(id, 'CANCEL', { userId: s.hospitalOwner.user.id, kind: 'PROVIDER' }, 'Doctor on leave');
    expect(await prisma.notification.count({ where: { channel: 'EMAIL', userId: s.p.user.id } })).toBe(0);
  });

  it('emails order status changes as Lab / Imaging / Pharmacy with a Title Case status, not the patient’s own cancellation', async () => {
    const p = await patient();
    const labStaff = await actor([]);
    const lab = await orderProvider('DIAGNOSTIC_LAB');
    const imaging = await orderProvider('IMAGING_CENTRE');
    const pharmacy = await orderProvider('PHARMACY');

    const dx = await prisma.diagnosticOrder.create({ data: orderBase(p.profileId, p.user.id, lab.id) });
    await diagnosticAction(dx.id, 'CONFIRMED', labStaff.user.id);
    await diagnosticAction(dx.id, 'SAMPLE_COLLECTED', labStaff.user.id);
    const img = await prisma.diagnosticOrder.create({ data: orderBase(p.profileId, p.user.id, imaging.id) });
    await diagnosticAction(img.id, 'REJECTED', labStaff.user.id, 'Machine under maintenance');
    const rx = await prisma.pharmacyOrder.create({ data: orderBase(p.profileId, p.user.id, pharmacy.id) });
    await advancePharmacyOrder(rx.id, 'ACCEPTED', labStaff.user.id);
    const ownCancel = await prisma.diagnosticOrder.create({ data: orderBase(p.profileId, p.user.id, lab.id) });
    await diagnosticAction(ownCancel.id, 'CANCELLED', p.user.id, 'Changed my mind');

    const mail = await emails('order.status_changed', p.user.id);
    expect(mail.every((m) => m.recipient === p.user.email)).toBe(true);
    expect(mail.map((m) => m.payload).sort((a, b) => String(a.reference).localeCompare(String(b.reference)) || String(a.status).localeCompare(String(b.status)))).toEqual(
      [
        { reference: dx.reference, kind: 'Lab', status: 'Confirmed' },
        { reference: dx.reference, kind: 'Lab', status: 'Sample Collected' },
        { reference: img.reference, kind: 'Imaging', status: 'Rejected' },
        { reference: rx.reference, kind: 'Pharmacy', status: 'Accepted' },
      ].sort((a, b) => a.reference.localeCompare(b.reference) || a.status.localeCompare(b.status)),
    );
    expect(await emails('order.status_changed', labStaff.user.id)).toHaveLength(0);
  });

  it('emails the requester when an emergency request changes status', async () => {
    const p = await patient();
    const sos = await p.post(`${V}/patient/emergency`, { district: 'Purba Medinipur' });
    expect(sos.status).toBe(201);
    expect(sos.body.data.status).toBe('NO_PROVIDER_AVAILABLE');
    const d = await prisma.dispatchRequest.findUniqueOrThrow({ where: { id: sos.body.data.requestId } });
    const mail = await emails('dispatch.status_changed', p.user.id);
    expect(mail).toHaveLength(1); // RECEIVED → SEARCHING is not emailed
    expect(mail[0]!.recipient).toBe(p.user.email);
    expect(mail[0]!.payload).toEqual({ reference: d.reference, status: 'No Provider Available' });

    const noEmail = await patient();
    await prisma.user.update({ where: { id: noEmail.user.id }, data: { email: null } });
    expect((await noEmail.post(`${V}/patient/emergency`, { district: 'Purba Medinipur' })).status).toBe(201);
    expect(await prisma.notification.count({ where: { channel: 'EMAIL', userId: noEmail.user.id } })).toBe(0);
  });

  it('emails the case owner when support replies visibly, not for internal notes or the author’s own case', async () => {
    const agent = await actor(['SUPPORT_AGENT']);
    const p = await patient();
    const c = await agent.post(`${V}/admin/support-cases`, { type: 'COMPLAINT', category: 'LATE_REPORT', subject: 'Report delayed', description: 'Report not delivered after 3 days.', reporterUserId: p.user.id });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect((await agent.post(`${V}/admin/support-cases/${c.body.data.id}/comments`, { body: 'Checking with the lab' })).status).toBe(201); // internal by default
    expect(await emails('support.reply', p.user.id)).toHaveLength(0);
    expect((await agent.post(`${V}/admin/support-cases/${c.body.data.id}/comments`, { body: 'The lab has re-issued your report.', isInternal: false })).status).toBe(201);
    const mail = await emails('support.reply', p.user.id);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toEqual({ recipient: p.user.email, payload: { caseReference: c.body.data.reference } });

    const own = await agent.post(`${V}/admin/support-cases`, { type: 'COMPLAINT', category: 'OTHER', subject: 'Own case', description: 'Raised by the agent.', reporterUserId: agent.user.id });
    expect((await agent.post(`${V}/admin/support-cases/${own.body.data.id}/comments`, { body: 'Note to self', isInternal: false })).status).toBe(201);
    expect(await emails('support.reply', agent.user.id)).toHaveLength(0);
  });
});

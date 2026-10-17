import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor } from '../helpers/factory.js';

beforeAll(resetDatabase);

describe('support desk', () => {
  it('serves options, tracks SLA and workload, filters the queue, and guards every transition', async () => {
    const agentA = await actor(['SUPPORT_AGENT']);
    const agentB = await actor(['SUPPORT_AGENT']);
    const auditor = await actor(['AUDITOR']);

    const opts = await agentA.get('/api/v1/admin/support-cases/options');
    expect(opts.status).toBe(200);
    expect(opts.body.data.priorities).toContainEqual({ priority: 'URGENT', slaHours: 4 });
    expect(opts.body.data.types.find((t: { type: string }) => t.type === 'DISPUTE').categories).toContain('OVERCHARGE');
    expect(opts.body.data.transitions.CLOSED).toEqual([]);
    const agentIds = opts.body.data.agents.map((a: { id: string }) => a.id);
    expect(agentIds).toContain(agentA.user.id);
    expect(agentIds).not.toContain(auditor.user.id);

    // Open an urgent case; the SLA is 4 h out and the case is unassigned.
    const open = await agentA.post('/api/v1/admin/support-cases', { type: 'DISPUTE', category: 'OVERCHARGE', priority: 'URGENT', subject: 'Charged twice for ECG', description: 'Patient shows two receipts for one ECG on 12 Oct.' });
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    const c = open.body.data;
    expect(c.slaHours).toBe(4);
    expect(c.slaRemainingMinutes).toBeGreaterThan(230);
    expect(c.allowedTransitions).toContain('ESCALATED');
    expect(c.createdByName).toBeTruthy();

    // Queue filters.
    expect((await agentA.get('/api/v1/admin/support-cases?unassignedOnly=true')).body.data.map((x: { id: string }) => x.id)).toContain(c.id);
    expect((await agentA.get('/api/v1/admin/support-cases?q=charged')).body.data.map((x: { id: string }) => x.id)).toContain(c.id);
    expect((await agentA.get(`/api/v1/admin/support-cases?q=${c.reference.toLowerCase()}`)).body.data).toHaveLength(1);
    expect((await agentA.get('/api/v1/admin/support-cases?dueWithinHours=5')).body.data.map((x: { id: string }) => x.id)).toContain(c.id);
    expect((await agentA.get('/api/v1/admin/support-cases?breachedOnly=true')).body.data.map((x: { id: string }) => x.id)).not.toContain(c.id);

    // Assignment: only support agents, no duplicate assignment, auto-moves OPEN → IN_PROGRESS.
    expect((await agentA.post(`/api/v1/admin/support-cases/${c.id}/assign`, { assigneeId: auditor.user.id })).status).toBe(400);
    const assigned = await agentA.post(`/api/v1/admin/support-cases/${c.id}/assign`, { assigneeId: agentB.user.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.status).toBe('IN_PROGRESS');
    expect(assigned.body.data.assignedToName).toBeTruthy();
    expect((await agentA.post(`/api/v1/admin/support-cases/${c.id}/assign`, { assigneeId: agentB.user.id })).status).toBe(409);
    expect((await agentB.get('/api/v1/admin/support-cases?assignedToMe=true')).body.data).toHaveLength(1);

    // Stats reflect the open workload; B sees it as theirs.
    const statsB = await agentB.get('/api/v1/admin/support-cases/stats');
    expect(statsB.body.data.mine).toBe(1);
    expect(statsB.body.data.open).toBeGreaterThanOrEqual(1);
    expect(statsB.body.data.dueWithin4h).toBeGreaterThanOrEqual(1);

    // Escalation and closing-without-resolution need a reason; resolution needs a note; version guard works.
    expect((await agentA.post(`/api/v1/admin/support-cases/${c.id}/status`, { status: 'ESCALATED' })).status).toBe(400);
    const esc = await agentA.post(`/api/v1/admin/support-cases/${c.id}/status`, { status: 'ESCALATED', note: 'Needs finance to check gateway logs', expectedVersion: assigned.body.data.version });
    expect(esc.status, JSON.stringify(esc.body)).toBe(200);
    expect((await agentA.post(`/api/v1/admin/support-cases/${c.id}/status`, { status: 'IN_PROGRESS', expectedVersion: assigned.body.data.version })).status).toBe(409); // stale version
    expect((await agentA.post(`/api/v1/admin/support-cases/${c.id}/status`, { status: 'CLOSED' })).status).toBe(400); // close without resolving needs a reason
    expect((await agentA.post(`/api/v1/admin/support-cases/${c.id}/status`, { status: 'AWAITING_REPORTER' })).status).toBe(409); // not allowed from ESCALATED

    // Simulate an SLA breach, then resolve: breached flag flips, resolvedWithinSla is false.
    await prisma.supportCase.update({ where: { id: c.id }, data: { slaDueAt: new Date(Date.now() - 60_000) } });
    const breached = await agentA.get(`/api/v1/admin/support-cases/${c.id}`);
    expect(breached.body.data.slaBreached).toBe(true);
    expect(breached.body.data.slaRemainingMinutes).toBeLessThan(0);
    expect((await agentA.get('/api/v1/admin/support-cases?breachedOnly=true')).body.data.map((x: { id: string }) => x.id)).toContain(c.id);
    const resolved = await agentA.post(`/api/v1/admin/support-cases/${c.id}/status`, { status: 'RESOLVED', note: 'Duplicate charge refunded to the patient.' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.resolvedWithinSla).toBe(false);
    expect(resolved.body.data.slaBreached).toBe(false);
    expect(resolved.body.data.slaRemainingMinutes).toBeNull();

    // Timeline carries author and assignee names, never raw ids only.
    const events = await agentA.get(`/api/v1/admin/support-cases/${c.id}/events`);
    expect(events.body.data.find((e: { kind: string }) => e.kind === 'ASSIGNMENT').metadata.assigneeName).toBeTruthy();
    expect(events.body.data.every((e: { authorName: string | null }) => e.authorName)).toBe(true);

    // Reopen, then close; closed cases refuse edits; read-only roles cannot act.
    expect((await agentA.post(`/api/v1/admin/support-cases/${c.id}/status`, { status: 'IN_PROGRESS' })).status).toBe(200);
    expect((await agentA.post(`/api/v1/admin/support-cases/${c.id}/status`, { status: 'RESOLVED', note: 'Confirmed with the patient.' })).status).toBe(200);
    expect((await agentA.post(`/api/v1/admin/support-cases/${c.id}/status`, { status: 'CLOSED' })).status).toBe(200);
    expect((await agentA.patch(`/api/v1/admin/support-cases/${c.id}`, { priority: 'LOW' })).status).toBe(409);
    expect((await auditor.get('/api/v1/admin/support-cases/stats')).status).toBe(200);
    expect((await auditor.post('/api/v1/admin/support-cases', { type: 'SUPPORT', category: 'OTHER', subject: 'Nope', description: 'Auditors cannot open cases' })).status).toBe(403);
    expect((await agentA.get('/api/v1/admin/support-cases/00000000-0000-7000-8000-000000000000/events')).status).toBe(404);
  });
});

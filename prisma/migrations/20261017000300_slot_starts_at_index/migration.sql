-- Time-window reports (e.g. "appointments today" on the dashboard) filter slots
-- by starts_at alone; the existing composite indexes lead with doctor/location.
CREATE INDEX "appointment_slots_starts_at_idx" ON "appointment_slots"("starts_at");

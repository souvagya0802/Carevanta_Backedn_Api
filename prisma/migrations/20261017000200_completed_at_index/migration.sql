-- Widen the completion-time index: the analytics GTV/commission queries and the
-- settlement window filter on service_completed_at without the
-- commission_eligible predicate, so the old partial index was unusable for them
-- (seq scan observed in load/results/query-plans.md).
DROP INDEX IF EXISTS "service_transactions_service_completed_at_idx";
CREATE INDEX "service_transactions_completed_at_idx" ON "service_transactions"("service_completed_at") WHERE (service_completed_at IS NOT NULL);

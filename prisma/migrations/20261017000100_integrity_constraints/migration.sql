-- Integrity constraints that Prisma's schema language cannot express.
-- Prisma Migrate does not model CHECK / EXCLUDE constraints or triggers, so they
-- live here. Every constraint is named so it can be referenced in error mapping
-- (src/lib/errors.ts) and in later expand/contract migrations.

-- --- Identity ----------------------------------------------------------------
ALTER TABLE "users"
  ADD CONSTRAINT "users_contact_required_chk"
  CHECK (email IS NOT NULL OR phone IS NOT NULL OR status = 'ANONYMISED'),
  ADD CONSTRAINT "users_failed_login_nonneg_chk" CHECK (failed_login_count >= 0);

-- --- Providers ---------------------------------------------------------------
ALTER TABLE "provider_locations"
  ADD CONSTRAINT "provider_locations_lat_chk" CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT "provider_locations_lng_chk" CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  ADD CONSTRAINT "provider_locations_pincode_chk" CHECK (pincode ~ '^[1-9][0-9]{5}$');

ALTER TABLE "provider_operating_hours"
  ADD CONSTRAINT "operating_hours_day_chk" CHECK (day_of_week BETWEEN 0 AND 6),
  ADD CONSTRAINT "operating_hours_range_chk"
  CHECK (opens_at_min BETWEEN 0 AND 1439 AND closes_at_min BETWEEN 1 AND 1440 AND closes_at_min > opens_at_min);

ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_rating_chk" CHECK (rating BETWEEN 1 AND 5);

ALTER TABLE "provider_documents"
  ADD CONSTRAINT "provider_documents_size_chk" CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  ADD CONSTRAINT "provider_documents_dates_chk" CHECK (expires_at IS NULL OR issued_at IS NULL OR expires_at >= issued_at);

-- --- Affiliations, schedules, slots ------------------------------------------
ALTER TABLE "doctor_affiliations"
  ADD CONSTRAINT "doctor_affiliations_distinct_parties_chk" CHECK (doctor_provider_id <> facility_provider_id),
  ADD CONSTRAINT "doctor_affiliations_dates_chk" CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  ADD CONSTRAINT "doctor_affiliations_fee_chk" CHECK (consultation_fee_minor IS NULL OR consultation_fee_minor >= 0);

ALTER TABLE "doctor_schedules"
  ADD CONSTRAINT "doctor_schedules_day_chk" CHECK (day_of_week BETWEEN 0 AND 6),
  ADD CONSTRAINT "doctor_schedules_range_chk"
  CHECK (start_minute BETWEEN 0 AND 1439 AND end_minute BETWEEN 1 AND 1440 AND end_minute > start_minute),
  ADD CONSTRAINT "doctor_schedules_slot_len_chk" CHECK (slot_minutes BETWEEN 5 AND 240),
  ADD CONSTRAINT "doctor_schedules_capacity_chk" CHECK (capacity_per_slot BETWEEN 1 AND 200),
  ADD CONSTRAINT "doctor_schedules_validity_chk" CHECK (valid_to IS NULL OR valid_to >= valid_from);

ALTER TABLE "appointment_slots"
  ADD CONSTRAINT "appointment_slots_time_chk" CHECK (ends_at > starts_at),
  ADD CONSTRAINT "appointment_slots_capacity_chk" CHECK (capacity BETWEEN 1 AND 200),
  ADD CONSTRAINT "appointment_slots_booked_chk" CHECK (booked_count >= 0 AND booked_count <= capacity),
  ADD CONSTRAINT "appointment_slots_fee_chk" CHECK (fee_minor >= 0);

-- A doctor cannot have two overlapping non-cancelled slots anywhere - this is
-- what stops the same doctor being bookable at two hospitals at once.
ALTER TABLE "appointment_slots"
  ADD CONSTRAINT "appointment_slots_no_overlap_excl"
  EXCLUDE USING gist (
    doctor_provider_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status <> 'CANCELLED');

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_fee_chk" CHECK (fee_minor >= 0);

-- --- Diagnostics / pharmacy --------------------------------------------------
ALTER TABLE "diagnostic_orders"
  ADD CONSTRAINT "diagnostic_orders_total_chk" CHECK (total_minor >= 0),
  ADD CONSTRAINT "diagnostic_orders_home_pincode_chk"
  CHECK (collection_mode <> 'HOME_COLLECTION' OR collection_pincode IS NOT NULL);

ALTER TABLE "diagnostic_order_items"
  ADD CONSTRAINT "diagnostic_order_items_price_chk" CHECK (price_minor >= 0);

ALTER TABLE "pharmacy_inventory"
  ADD CONSTRAINT "pharmacy_inventory_qty_chk"
  CHECK (quantity_on_hand >= 0 AND quantity_reserved >= 0 AND quantity_reserved <= quantity_on_hand),
  ADD CONSTRAINT "pharmacy_inventory_price_chk"
  CHECK (mrp_minor >= 0 AND selling_price_minor >= 0 AND selling_price_minor <= mrp_minor);

ALTER TABLE "pharmacy_orders"
  ADD CONSTRAINT "pharmacy_orders_total_chk" CHECK (total_minor >= 0),
  ADD CONSTRAINT "pharmacy_orders_delivery_pincode_chk"
  CHECK (fulfilment <> 'DELIVERY' OR delivery_pincode IS NOT NULL);

ALTER TABLE "pharmacy_order_items"
  ADD CONSTRAINT "pharmacy_order_items_qty_chk" CHECK (quantity > 0 AND unit_price_minor >= 0);

-- --- Finance -----------------------------------------------------------------
ALTER TABLE "service_transactions"
  ADD CONSTRAINT "service_transactions_one_source_chk"
  CHECK (num_nonnulls(appointment_id, diagnostic_order_id, pharmacy_order_id, dispatch_request_id) = 1),
  ADD CONSTRAINT "service_transactions_source_match_chk" CHECK (
    (source_type = 'APPOINTMENT' AND appointment_id IS NOT NULL) OR
    (source_type = 'DIAGNOSTIC_ORDER' AND diagnostic_order_id IS NOT NULL) OR
    (source_type = 'PHARMACY_ORDER' AND pharmacy_order_id IS NOT NULL) OR
    (source_type = 'AMBULANCE_DISPATCH' AND dispatch_request_id IS NOT NULL)
  ),
  ADD CONSTRAINT "service_transactions_amounts_chk"
  CHECK (gross_minor >= 0 AND refunded_minor >= 0 AND refunded_minor <= gross_minor);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amounts_chk"
  CHECK (amount_minor > 0 AND refunded_minor >= 0 AND refunded_minor <= amount_minor);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_chk" CHECK (amount_minor > 0);

ALTER TABLE "commission_policies"
  ADD CONSTRAINT "commission_policies_method_chk" CHECK (
    (method = 'PERCENTAGE' AND rate_bps IS NOT NULL AND flat_minor IS NULL) OR
    (method = 'FLAT' AND flat_minor IS NOT NULL AND rate_bps IS NULL)
  ),
  ADD CONSTRAINT "commission_policies_rate_chk" CHECK (rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT "commission_policies_tax_chk" CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT "commission_policies_flat_chk" CHECK (flat_minor IS NULL OR flat_minor >= 0),
  ADD CONSTRAINT "commission_policies_bounds_chk"
  CHECK ((min_minor IS NULL OR min_minor >= 0) AND (max_minor IS NULL OR max_minor >= 0)
         AND (min_minor IS NULL OR max_minor IS NULL OR min_minor <= max_minor)),
  ADD CONSTRAINT "commission_policies_effective_chk" CHECK (effective_to IS NULL OR effective_to > effective_from),
  ADD CONSTRAINT "commission_policies_version_chk" CHECK (version >= 1);

-- scope_key is derived; enum->text casts are not IMMUTABLE so it cannot be a
-- generated column, hence a trigger.
CREATE FUNCTION commission_policies_set_scope_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.scope_key := NEW.category::text || '|' ||
                   COALESCE(NEW.provider_type::text, '*') || '|' ||
                   COALESCE(NEW.provider_id::text, '*');
  RETURN NEW;
END;
$$;

CREATE TRIGGER commission_policies_scope_key_trg
BEFORE INSERT OR UPDATE OF category, provider_type, provider_id ON "commission_policies"
FOR EACH ROW EXECUTE FUNCTION commission_policies_set_scope_key();

-- Two ACTIVE policies for the same scope may not overlap in time.
ALTER TABLE "commission_policies"
  ADD CONSTRAINT "commission_policies_no_overlap_excl"
  EXCLUDE USING gist (
    scope_key WITH =,
    tstzrange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (status = 'ACTIVE');

ALTER TABLE "commission_snapshots"
  ADD CONSTRAINT "commission_snapshots_amounts_chk"
  CHECK (base_minor >= 0 AND commission_minor >= 0 AND tax_minor >= 0 AND provider_net_minor = base_minor - commission_minor - tax_minor);

ALTER TABLE "settlement_items"
  ADD CONSTRAINT "settlement_items_amount_chk" CHECK (amount_minor > 0),
  ADD CONSTRAINT "settlement_items_paid_evidence_chk"
  CHECK (status <> 'PAID' OR (payout_reference IS NOT NULL AND paid_at IS NOT NULL));

ALTER TABLE "settlement_batches"
  ADD CONSTRAINT "settlement_batches_maker_checker_chk"
  CHECK (approved_by_id IS NULL OR approved_by_id <> created_by_id);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_maker_checker_chk"
  CHECK (reviewed_by_id IS NULL OR requested_by_id IS NULL OR reviewed_by_id <> requested_by_id);

ALTER TABLE "commission_policies"
  ADD CONSTRAINT "commission_policies_maker_checker_chk"
  CHECK (approved_by_id IS NULL OR created_by_id IS NULL OR approved_by_id <> created_by_id);

-- --- Immutability triggers ---------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;

-- Audit trail: no UPDATE or DELETE, ever. (Retention purges run as a dedicated
-- maintenance role that disables the trigger inside an audited procedure.)
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER sensitive_access_logs_append_only
BEFORE UPDATE OR DELETE ON "sensitive_access_logs"
FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Ledger: amounts are immutable; only linking/unlinking to a settlement item
-- is permitted. Corrections are new compensating entries.
CREATE FUNCTION ledger_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider_ledger_entries is append-only' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.provider_id <> OLD.provider_id OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.entry_type <> OLD.entry_type OR NEW.dedupe_key <> OLD.dedupe_key
     OR NEW.currency <> OLD.currency OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
    RAISE EXCEPTION 'provider_ledger_entries amounts are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_ledger_entries_guard_trg
BEFORE UPDATE OR DELETE ON "provider_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION ledger_entries_guard();

-- Commission snapshots: numbers are immutable; only reversal metadata may change.
CREATE FUNCTION commission_snapshots_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commission_snapshots is append-only' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.base_minor <> OLD.base_minor OR NEW.commission_minor <> OLD.commission_minor
     OR NEW.tax_minor <> OLD.tax_minor OR NEW.provider_net_minor <> OLD.provider_net_minor
     OR NEW.policy_id <> OLD.policy_id OR NEW.transaction_id <> OLD.transaction_id
     OR (OLD.status = 'REVERSED' AND NEW.status <> 'REVERSED') THEN
    RAISE EXCEPTION 'commission_snapshots values are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commission_snapshots_guard_trg
BEFORE UPDATE OR DELETE ON "commission_snapshots"
FOR EACH ROW EXECUTE FUNCTION commission_snapshots_guard();

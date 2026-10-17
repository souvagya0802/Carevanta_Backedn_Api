-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "SupportCaseType" AS ENUM ('COMPLAINT', 'DISPUTE', 'SUPPORT', 'REFUND_REQUEST', 'PROVIDER_REPORT');

-- CreateEnum
CREATE TYPE "SupportCasePriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'AWAITING_REPORTER', 'ESCALATED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS', 'PUSH', 'IN_APP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'DENIED', 'FAILURE');

-- CreateEnum
CREATE TYPE "ConsentScope" AS ENUM ('PLATFORM_DATA_PROCESSING', 'REPORT_SHARING', 'RECORD_ACCESS_BY_PROVIDER', 'COMMUNICATIONS');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'CONTAINED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MappingReviewStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'RETIRED');

-- CreateEnum
CREATE TYPE "MappingRelevance" AS ENUM ('PRIMARY', 'SECONDARY');

-- CreateEnum
CREATE TYPE "ServiceCategory" AS ENUM ('CONSULTATION', 'DIAGNOSTIC_TEST', 'IMAGING', 'PROCEDURE', 'SURGERY', 'PHARMACY', 'AMBULANCE', 'HOME_CARE', 'OTHER');

-- CreateEnum
CREATE TYPE "MedicineSchedule" AS ENUM ('OTC', 'SCHEDULE_G', 'SCHEDULE_H', 'SCHEDULE_H1', 'SCHEDULE_X', 'OTHER');

-- CreateEnum
CREATE TYPE "TransactionSourceType" AS ENUM ('APPOINTMENT', 'DIAGNOSTIC_ORDER', 'PHARMACY_ORDER', 'AMBULANCE_DISPATCH');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'PAY_AT_PROVIDER', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CommissionCategory" AS ENUM ('CONSULTATION', 'DIAGNOSTIC', 'PHARMACY', 'PROCEDURE', 'SURGERY', 'AMBULANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "CommissionMethod" AS ENUM ('PERCENTAGE', 'FLAT');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "LegalReviewStatus" AS ENUM ('NOT_REVIEWED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaymentGateway" AS ENUM ('RAZORPAY', 'TEST_GATEWAY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "CommissionSnapshotStatus" AS ENUM ('PROVISIONAL', 'FINAL', 'REVERSED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('SERVICE_EARNING', 'COMMISSION', 'COMMISSION_TAX', 'REFUND_CLAWBACK', 'COMMISSION_REVERSAL', 'SETTLEMENT_PAYOUT', 'SETTLEMENT_REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "SettlementBatchStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'COMPLETED', 'PARTIALLY_FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SettlementItemStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('MATCHED', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'MISSING_INTERNAL', 'MISSING_AT_GATEWAY', 'RESOLVED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'ANONYMISED');

-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('PLATFORM', 'PROVIDER', 'PATIENT');

-- CreateEnum
CREATE TYPE "TokenPurpose" AS ENUM ('PASSWORD_RESET', 'EMAIL_VERIFICATION', 'PHONE_VERIFICATION');

-- CreateEnum
CREATE TYPE "AffiliationStatus" AS ENUM ('INVITED', 'REQUESTED', 'PENDING_VERIFICATION', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AffiliationInitiator" AS ENUM ('FACILITY', 'DOCTOR', 'PLATFORM');

-- CreateEnum
CREATE TYPE "EngagementType" AS ENUM ('FULL_TIME', 'PART_TIME', 'VISITING', 'CONSULTANT');

-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('OPEN', 'BLOCKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PatientRelationship" AS ENUM ('SELF', 'SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'OTHER');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_PROVIDER', 'CANCELLED_BY_PLATFORM', 'REJECTED', 'NO_SHOW', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('PATIENT_APP', 'PROVIDER_PORTAL', 'ADMIN_CONSOLE', 'WALK_IN');

-- CreateEnum
CREATE TYPE "Attribution" AS ENUM ('PLATFORM', 'PROVIDER_DIRECT', 'ADMIN_ASSISTED');

-- CreateEnum
CREATE TYPE "ConsultationMode" AS ENUM ('IN_PERSON', 'TELECONSULTATION');

-- CreateEnum
CREATE TYPE "DiagnosticOrderStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'SAMPLE_COLLECTED', 'PROCESSING', 'REPORT_READY', 'COMPLETED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CollectionMode" AS ENUM ('CENTRE_VISIT', 'HOME_COLLECTION');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'AMENDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PrescriptionReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PharmacyOrderStatus" AS ENUM ('PLACED', 'PRESCRIPTION_REVIEW', 'ACCEPTED', 'REJECTED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'RETURNED');

-- CreateEnum
CREATE TYPE "FulfilmentMode" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('BLS', 'ALS', 'PATIENT_TRANSPORT', 'NEONATAL', 'MORTUARY');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('PENDING_VERIFICATION', 'AVAILABLE', 'ON_TRIP', 'OUT_OF_SERVICE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CrewRole" AS ENUM ('DRIVER', 'EMT', 'PARAMEDIC', 'NURSE');

-- CreateEnum
CREATE TYPE "DispatchMode" AS ENUM ('LIVE', 'TEST');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('RECEIVED', 'SEARCHING', 'OFFERED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'PATIENT_ONBOARD', 'AT_DESTINATION', 'COMPLETED', 'CANCELLED', 'NO_PROVIDER_AVAILABLE', 'ESCALATED');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ConfirmationSource" AS ENUM ('OPERATOR_APP', 'OPERATOR_PHONE_CONFIRMED');

-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('DOCTOR', 'HOSPITAL', 'CLINIC', 'DIAGNOSTIC_LAB', 'IMAGING_CENTRE', 'PHARMACY', 'AMBULANCE_OPERATOR');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "RegionStatus" AS ENUM ('PLANNED', 'PILOT', 'LIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "OwnershipType" AS ENUM ('PRIVATE', 'GOVERNMENT', 'TRUST_OR_NGO', 'OTHER');

-- CreateEnum
CREATE TYPE "ProviderMemberRole" AS ENUM ('OWNER', 'ADMIN', 'STAFF', 'PHARMACIST', 'LAB_TECHNICIAN', 'DISPATCHER');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('INVITED', 'ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('MEDICAL_REGISTRATION_CERTIFICATE', 'DEGREE_CERTIFICATE', 'IDENTITY_PROOF', 'GST_CERTIFICATE', 'CLINICAL_ESTABLISHMENT_REGISTRATION', 'TRADE_LICENSE', 'DRUG_LICENSE', 'PHARMACIST_REGISTRATION', 'NABL_ACCREDITATION', 'AERB_LICENSE', 'PCPNDT_REGISTRATION', 'FIRE_NOC', 'BIOMEDICAL_WASTE_AUTHORISATION', 'VEHICLE_REGISTRATION_CERTIFICATE', 'VEHICLE_INSURANCE', 'VEHICLE_FITNESS_CERTIFICATE', 'VEHICLE_PERMIT', 'DRIVING_LICENSE', 'BANK_PROOF', 'AGREEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "VerificationCaseKind" AS ENUM ('ONBOARDING', 'RENEWAL', 'CHANGE_REQUEST', 'COMPLAINT_TRIGGERED', 'PERIODIC_REVIEW');

-- CreateEnum
CREATE TYPE "VerificationCaseStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'AWAITING_PROVIDER', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VerificationCheckType" AS ENUM ('IDENTITY', 'PROFESSIONAL_REGISTRATION', 'QUALIFICATION', 'FACILITY_REGISTRATION', 'TAX_REGISTRATION', 'DRUG_LICENSE', 'RADIOLOGY_LICENSE', 'ACCREDITATION', 'VEHICLE_REGISTRATION', 'VEHICLE_INSURANCE', 'ADDRESS', 'BANK_ACCOUNT');

-- CreateEnum
CREATE TYPE "VerificationCheckStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'WAIVED');

-- CreateEnum
CREATE TYPE "VerificationMethod" AS ENUM ('MANUAL_DOCUMENT_REVIEW', 'OFFICIAL_REGISTRY_LOOKUP', 'AUTHORISED_THIRD_PARTY_API', 'ISSUER_CONFIRMATION', 'PHYSICAL_INSPECTION');

-- CreateEnum
CREATE TYPE "PayoutAccountStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'DISABLED');

-- CreateEnum
CREATE TYPE "AgreementStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING_MODERATION', 'PUBLISHED', 'REJECTED', 'HIDDEN');

-- CreateTable
CREATE TABLE "support_cases" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reference" VARCHAR(24) NOT NULL,
    "type" "SupportCaseType" NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "priority" "SupportCasePriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
    "subject" VARCHAR(200) NOT NULL,
    "description" VARCHAR(5000) NOT NULL,
    "reporter_user_id" UUID,
    "provider_id" UUID,
    "transaction_id" UUID,
    "assigned_to_id" UUID,
    "sla_due_at" TIMESTAMPTZ(3),
    "resolution" VARCHAR(5000),
    "resolved_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "support_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_case_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "case_id" UUID NOT NULL,
    "author_id" UUID,
    "kind" VARCHAR(24) NOT NULL,
    "body" VARCHAR(5000),
    "is_internal" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_case_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_notes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "subject_type" VARCHAR(48) NOT NULL,
    "subject_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" VARCHAR(5000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" VARCHAR(96) NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "locale" VARCHAR(8) NOT NULL DEFAULT 'en',
    "version" INTEGER NOT NULL DEFAULT 1,
    "subject" VARCHAR(200),
    "body" VARCHAR(8000) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "template_key" VARCHAR(96) NOT NULL,
    "recipient" VARCHAR(200) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" VARCHAR(96) NOT NULL,
    "value" JSONB NOT NULL,
    "description" VARCHAR(500),
    "is_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "export_type" VARCHAR(64) NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "purpose" VARCHAR(500) NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "requested_by_id" UUID NOT NULL,
    "row_count" INTEGER,
    "storage_key" VARCHAR(300),
    "error" VARCHAR(1000),
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "actor_type" VARCHAR(16) NOT NULL DEFAULT 'USER',
    "action" VARCHAR(96) NOT NULL,
    "entity_type" VARCHAR(48) NOT NULL,
    "entity_id" VARCHAR(64),
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'SUCCESS',
    "request_id" VARCHAR(64),
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(300),
    "metadata" JSONB,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sensitive_access_logs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "actor_user_id" UUID,
    "resource_type" VARCHAR(48) NOT NULL,
    "resource_id" UUID NOT NULL,
    "purpose" VARCHAR(300) NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "request_id" VARCHAR(64),
    "accessed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sensitive_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "patient_profile_id" UUID NOT NULL,
    "granted_by_user_id" UUID NOT NULL,
    "grantee_provider_id" UUID,
    "scope" "ConsentScope" NOT NULL,
    "purpose" VARCHAR(500) NOT NULL,
    "policy_version" VARCHAR(32) NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),
    "withdrawn_at" TIMESTAMPTZ(3),

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_holds" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "entity_type" VARCHAR(48) NOT NULL,
    "entity_id" UUID NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "placed_by_id" UUID NOT NULL,
    "placed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(3),
    "released_by_id" UUID,

    CONSTRAINT "legal_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_incidents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reference" VARCHAR(24) NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "title" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(5000) NOT NULL,
    "detected_at" TIMESTAMPTZ(3) NOT NULL,
    "contained_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "personal_data_affected" BOOLEAN NOT NULL DEFAULT false,
    "regulator_notified_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "security_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialities" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "parent_id" UUID,
    "description" VARCHAR(1000),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "specialities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conditions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(180) NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'CONDITION',
    "synonyms" VARCHAR(120)[] DEFAULT ARRAY[]::VARCHAR(120)[],
    "is_red_flag" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "condition_speciality_mappings" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "condition_id" UUID NOT NULL,
    "speciality_id" UUID NOT NULL,
    "relevance" "MappingRelevance" NOT NULL DEFAULT 'PRIMARY',
    "review_status" "MappingReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "rationale" VARCHAR(1000),
    "proposed_by_id" UUID,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "condition_speciality_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "speciality_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facility_departments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "verified_at" TIMESTAMPTZ(3),
    "verified_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facility_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amenities" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category" VARCHAR(48) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amenities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_amenities" (
    "provider_id" UUID NOT NULL,
    "amenity_id" UUID NOT NULL,
    "verified_at" TIMESTAMPTZ(3),
    "verified_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_amenities_pkey" PRIMARY KEY ("provider_id","amenity_id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "category" "ServiceCategory" NOT NULL,
    "speciality_id" UUID,
    "description" VARCHAR(2000),
    "requires_prescription" BOOLEAN NOT NULL DEFAULT false,
    "sample_type" VARCHAR(64),
    "fasting_required" BOOLEAN,
    "preparation_instructions" VARCHAR(2000),
    "is_panel" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_panel_items" (
    "panel_id" UUID NOT NULL,
    "component_id" UUID NOT NULL,

    CONSTRAINT "service_panel_items_pkey" PRIMARY KEY ("panel_id","component_id")
);

-- CreateTable
CREATE TABLE "provider_services" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "location_id" UUID,
    "price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "home_service_available" BOOLEAN NOT NULL DEFAULT false,
    "turnaround_hours" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medicines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" VARCHAR(200) NOT NULL,
    "generic_name" VARCHAR(200),
    "strength" VARCHAR(64),
    "dosage_form" VARCHAR(64),
    "pack_size" VARCHAR(64),
    "manufacturer" VARCHAR(160),
    "schedule" "MedicineSchedule" NOT NULL DEFAULT 'OTC',
    "requires_prescription" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "medicines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_transactions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reference" VARCHAR(24) NOT NULL,
    "source_type" "TransactionSourceType" NOT NULL,
    "appointment_id" UUID,
    "diagnostic_order_id" UUID,
    "pharmacy_order_id" UUID,
    "dispatch_request_id" UUID,
    "provider_id" UUID NOT NULL,
    "patient_profile_id" UUID,
    "category" "CommissionCategory" NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "refunded_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "attribution" "Attribution" NOT NULL,
    "commission_eligible" BOOLEAN NOT NULL DEFAULT false,
    "eligibility_reason" VARCHAR(200),
    "service_completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_policies" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(2000),
    "category" "CommissionCategory" NOT NULL,
    "provider_type" "ProviderType",
    "provider_id" UUID,
    "agreement_id" UUID,
    "scope_key" VARCHAR(120) NOT NULL DEFAULT '',
    "method" "CommissionMethod" NOT NULL,
    "rate_bps" INTEGER,
    "flat_minor" BIGINT,
    "min_minor" BIGINT,
    "max_minor" BIGINT,
    "tax_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status" "PolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "legal_review_status" "LegalReviewStatus" NOT NULL DEFAULT 'NOT_REVIEWED',
    "legal_review_note" VARCHAR(2000),
    "legal_reviewed_by_id" UUID,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "effective_to" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "commission_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "transaction_id" UUID NOT NULL,
    "gateway" "PaymentGateway" NOT NULL,
    "gateway_order_id" VARCHAR(64) NOT NULL,
    "gateway_payment_id" VARCHAR(64),
    "amount_minor" BIGINT NOT NULL,
    "refunded_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "method" VARCHAR(32),
    "failure_code" VARCHAR(64),
    "failure_reason" VARCHAR(500),
    "captured_at" TIMESTAMPTZ(3),
    "idempotency_key" VARCHAR(80),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "gateway" "PaymentGateway" NOT NULL,
    "event_id" VARCHAR(100) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "processing_status" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "processing_error" VARCHAR(1000),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reference" VARCHAR(24) NOT NULL,
    "transaction_id" UUID NOT NULL,
    "payment_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "reason" VARCHAR(500) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_by_id" UUID,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" VARCHAR(1000),
    "gateway_refund_id" VARCHAR(64),
    "processed_at" TIMESTAMPTZ(3),
    "failure_reason" VARCHAR(500),
    "idempotency_key" VARCHAR(80),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_snapshots" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "transaction_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_code" VARCHAR(64) NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "method" "CommissionMethod" NOT NULL,
    "rate_bps" INTEGER,
    "flat_minor" BIGINT,
    "min_minor" BIGINT,
    "max_minor" BIGINT,
    "tax_rate_bps" INTEGER NOT NULL,
    "base_minor" BIGINT NOT NULL,
    "commission_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "provider_net_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "CommissionSnapshotStatus" NOT NULL DEFAULT 'FINAL',
    "calculated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ(3),
    "reversal_reason" VARCHAR(500),

    CONSTRAINT "commission_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_ledger_entries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "transaction_id" UUID,
    "settlement_item_id" UUID,
    "entry_type" "LedgerEntryType" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "dedupe_key" VARCHAR(120) NOT NULL,
    "description" VARCHAR(300),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_batches" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reference" VARCHAR(24) NOT NULL,
    "status" "SettlementBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settlement_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "batch_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "payout_account_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status" "SettlementItemStatus" NOT NULL DEFAULT 'PENDING',
    "payout_reference" VARCHAR(64),
    "paid_at" TIMESTAMPTZ(3),
    "evidence_note" VARCHAR(1000),
    "failure_reason" VARCHAR(500),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "recorded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settlement_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_records" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "run_id" UUID NOT NULL,
    "gateway" "PaymentGateway" NOT NULL,
    "gateway_reference" VARCHAR(64),
    "payment_id" UUID,
    "expected_minor" BIGINT,
    "actual_minor" BIGINT,
    "expected_status" VARCHAR(32),
    "actual_status" VARCHAR(32),
    "status" "ReconciliationStatus" NOT NULL,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "scope" VARCHAR(120) NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" CITEXT,
    "phone" VARCHAR(16),
    "full_name" VARCHAR(160) NOT NULL,
    "password_hash" VARCHAR(255),
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "email_verified_at" TIMESTAMPTZ(3),
    "phone_verified_at" TIMESTAMPTZ(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "password_changed_at" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "preferred_language" VARCHAR(8) NOT NULL DEFAULT 'en',
    "status_reason" VARCHAR(500),
    "anonymised_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by_id" UUID,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "scope" "RoleScope" NOT NULL DEFAULT 'PLATFORM',
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "key" VARCHAR(96) NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "is_sensitive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by_id" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,
    "reason" VARCHAR(500),

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "refresh_token_hash" CHAR(64) NOT NULL,
    "user_agent" VARCHAR(300),
    "ip_address" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "rotated_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(64),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID,
    "identifier_hash" CHAR(64) NOT NULL,
    "ip_address" VARCHAR(64),
    "success" BOOLEAN NOT NULL,
    "reason" VARCHAR(48) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "purpose" "TokenPurpose" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_affiliations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "doctor_provider_id" UUID NOT NULL,
    "facility_provider_id" UUID NOT NULL,
    "location_id" UUID,
    "department_id" UUID,
    "role_title" VARCHAR(120),
    "engagement_type" "EngagementType" NOT NULL DEFAULT 'VISITING',
    "consultation_fee_minor" BIGINT,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status" "AffiliationStatus" NOT NULL,
    "initiated_by" "AffiliationInitiator" NOT NULL,
    "requested_by_id" UUID,
    "doctor_confirmed_at" TIMESTAMPTZ(3),
    "facility_confirmed_at" TIMESTAMPTZ(3),
    "verified_by_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "start_date" DATE,
    "end_date" DATE,
    "status_reason" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "doctor_affiliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliation_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "affiliation_id" UUID NOT NULL,
    "from_status" "AffiliationStatus",
    "to_status" "AffiliationStatus" NOT NULL,
    "actor_user_id" UUID,
    "actor_kind" VARCHAR(24) NOT NULL,
    "note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_schedules" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "doctor_provider_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "affiliation_id" UUID,
    "day_of_week" SMALLINT NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "end_minute" SMALLINT NOT NULL,
    "slot_minutes" SMALLINT NOT NULL,
    "capacity_per_slot" SMALLINT NOT NULL DEFAULT 1,
    "fee_minor" BIGINT,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "doctor_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_slots" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "doctor_provider_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "affiliation_id" UUID,
    "schedule_id" UUID,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "capacity" SMALLINT NOT NULL DEFAULT 1,
    "booked_count" SMALLINT NOT NULL DEFAULT 0,
    "status" "SlotStatus" NOT NULL DEFAULT 'OPEN',
    "fee_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointment_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_profiles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_user_id" UUID NOT NULL,
    "full_name" VARCHAR(160) NOT NULL,
    "relationship" "PatientRelationship" NOT NULL DEFAULT 'SELF',
    "date_of_birth" DATE,
    "gender" VARCHAR(24),
    "phone" VARCHAR(16),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patient_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reference" VARCHAR(24) NOT NULL,
    "patient_profile_id" UUID NOT NULL,
    "booked_by_user_id" UUID NOT NULL,
    "doctor_provider_id" UUID NOT NULL,
    "facility_provider_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "affiliation_id" UUID,
    "mode" "ConsultationMode" NOT NULL DEFAULT 'IN_PERSON',
    "status" "AppointmentStatus" NOT NULL DEFAULT 'REQUESTED',
    "source" "BookingSource" NOT NULL,
    "attribution" "Attribution" NOT NULL,
    "fee_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "reason_for_visit" VARCHAR(500),
    "rescheduled_from_id" UUID,
    "idempotency_key" VARCHAR(80),
    "status_reason" VARCHAR(1000),
    "confirmed_at" TIMESTAMPTZ(3),
    "checked_in_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "appointment_id" UUID NOT NULL,
    "from_status" "AppointmentStatus",
    "to_status" "AppointmentStatus" NOT NULL,
    "actor_user_id" UUID,
    "actor_kind" VARCHAR(24) NOT NULL,
    "note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_orders" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reference" VARCHAR(24) NOT NULL,
    "patient_profile_id" UUID NOT NULL,
    "booked_by_user_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "location_id" UUID,
    "collection_mode" "CollectionMode" NOT NULL DEFAULT 'CENTRE_VISIT',
    "scheduled_at" TIMESTAMPTZ(3),
    "collection_pincode" CHAR(6),
    "prescription_id" UUID,
    "status" "DiagnosticOrderStatus" NOT NULL DEFAULT 'REQUESTED',
    "source" "BookingSource" NOT NULL,
    "attribution" "Attribution" NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status_reason" VARCHAR(1000),
    "idempotency_key" VARCHAR(80),
    "completed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "diagnostic_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_order_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "provider_service_id" UUID NOT NULL,
    "service_name" VARCHAR(200) NOT NULL,
    "price_minor" BIGINT NOT NULL,

    CONSTRAINT "diagnostic_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_reports" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "storage_key" VARCHAR(300) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "supersedes_id" UUID,
    "correction_reason" VARCHAR(1000),
    "published_by_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnostic_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescriptions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "patient_profile_id" UUID NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "issued_by_doctor_provider_id" UUID,
    "storage_key" VARCHAR(300) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "review_status" "PrescriptionReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" VARCHAR(1000),
    "issued_on" DATE,
    "valid_until" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_inventory" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "medicine_id" UUID NOT NULL,
    "batch_number" VARCHAR(64) NOT NULL,
    "expiry_date" DATE NOT NULL,
    "quantity_on_hand" INTEGER NOT NULL,
    "quantity_reserved" INTEGER NOT NULL DEFAULT 0,
    "mrp_minor" BIGINT NOT NULL,
    "selling_price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pharmacy_inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_orders" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reference" VARCHAR(24) NOT NULL,
    "patient_profile_id" UUID NOT NULL,
    "booked_by_user_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "location_id" UUID,
    "fulfilment" "FulfilmentMode" NOT NULL DEFAULT 'PICKUP',
    "delivery_pincode" CHAR(6),
    "prescription_id" UUID,
    "status" "PharmacyOrderStatus" NOT NULL DEFAULT 'PLACED',
    "source" "BookingSource" NOT NULL,
    "attribution" "Attribution" NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status_reason" VARCHAR(1000),
    "idempotency_key" VARCHAR(80),
    "completed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pharmacy_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_order_items" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "order_id" UUID NOT NULL,
    "medicine_id" UUID NOT NULL,
    "inventory_id" UUID,
    "quantity" INTEGER NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "substituted_for_medicine_id" UUID,

    CONSTRAINT "pharmacy_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ambulance_vehicles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "operator_provider_id" UUID NOT NULL,
    "base_location_id" UUID,
    "registration_number" VARCHAR(16) NOT NULL,
    "vehicle_type" "VehicleType" NOT NULL,
    "status" "VehicleStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "equipment" VARCHAR(64)[] DEFAULT ARRAY[]::VARCHAR(64)[],
    "insurance_valid_until" DATE,
    "fitness_valid_until" DATE,
    "last_known_latitude" DECIMAL(9,6),
    "last_known_longitude" DECIMAL(9,6),
    "last_location_at" TIMESTAMPTZ(3),
    "verified_at" TIMESTAMPTZ(3),
    "verified_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ambulance_vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ambulance_crew_members" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "operator_provider_id" UUID NOT NULL,
    "user_id" UUID,
    "full_name" VARCHAR(160) NOT NULL,
    "role" "CrewRole" NOT NULL,
    "license_number" VARCHAR(64),
    "license_valid_until" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ambulance_crew_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_requests" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reference" VARCHAR(24) NOT NULL,
    "mode" "DispatchMode" NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'RECEIVED',
    "requested_by_user_id" UUID,
    "caller_phone" VARCHAR(16),
    "pickup_latitude" DECIMAL(9,6),
    "pickup_longitude" DECIMAL(9,6),
    "pickup_address" VARCHAR(500),
    "pickup_district" VARCHAR(80),
    "destination_provider_id" UUID,
    "required_vehicle_type" "VehicleType",
    "emergency_guidance_shown_at" TIMESTAMPTZ(3),
    "escalated_at" TIMESTAMPTZ(3),
    "escalation_note" VARCHAR(1000),
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dispatch_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_assignments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "request_id" UUID NOT NULL,
    "operator_provider_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'OFFERED',
    "confirmation_source" "ConfirmationSource",
    "confirmed_by_user_id" UUID,
    "offered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ(3),
    "eta_minutes" INTEGER,
    "note" VARCHAR(500),

    CONSTRAINT "dispatch_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "request_id" UUID NOT NULL,
    "from_status" "DispatchStatus",
    "to_status" "DispatchStatus" NOT NULL,
    "actor_user_id" UUID,
    "actor_kind" VARCHAR(24) NOT NULL,
    "note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_regions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "district" VARCHAR(80) NOT NULL,
    "state" VARCHAR(80) NOT NULL,
    "status" "RegionStatus" NOT NULL DEFAULT 'PLANNED',
    "launched_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "type" "ProviderType" NOT NULL,
    "status" "ProviderStatus" NOT NULL DEFAULT 'DRAFT',
    "legal_name" VARCHAR(200) NOT NULL,
    "display_name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(220) NOT NULL,
    "description" VARCHAR(4000),
    "contact_email" CITEXT,
    "contact_phone" VARCHAR(16),
    "gstin" VARCHAR(15),
    "registration_number" VARCHAR(80),
    "is_listed" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),
    "approved_by_id" UUID,
    "suspended_at" TIMESTAMPTZ(3),
    "status_reason" VARCHAR(1000),
    "rating_average" DECIMAL(3,2),
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_profiles" (
    "provider_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "gender" VARCHAR(24),
    "years_of_experience" SMALLINT,
    "languages" VARCHAR(32)[] DEFAULT ARRAY[]::VARCHAR(32)[],
    "default_fee_minor" BIGINT,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "bio" VARCHAR(4000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "doctor_profiles_pkey" PRIMARY KEY ("provider_id")
);

-- CreateTable
CREATE TABLE "doctor_specialities" (
    "doctor_provider_id" UUID NOT NULL,
    "speciality_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_specialities_pkey" PRIMARY KEY ("doctor_provider_id","speciality_id")
);

-- CreateTable
CREATE TABLE "doctor_qualifications" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "doctor_provider_id" UUID NOT NULL,
    "degree" VARCHAR(120) NOT NULL,
    "institution" VARCHAR(200) NOT NULL,
    "year_awarded" SMALLINT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_registrations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "doctor_provider_id" UUID NOT NULL,
    "council" VARCHAR(160) NOT NULL,
    "registration_number" VARCHAR(64) NOT NULL,
    "registration_year" SMALLINT,
    "valid_until" DATE,
    "verified_at" TIMESTAMPTZ(3),
    "verified_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "professional_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facility_profiles" (
    "provider_id" UUID NOT NULL,
    "ownership_type" "OwnershipType" NOT NULL DEFAULT 'PRIVATE',
    "bed_count" INTEGER,
    "icu_bed_count" INTEGER,
    "has_emergency" BOOLEAN NOT NULL DEFAULT false,
    "is_open_24x7" BOOLEAN NOT NULL DEFAULT false,
    "establishment_registration_no" VARCHAR(80),
    "establishment_registration_authority" VARCHAR(160),
    "accreditations" VARCHAR(64)[] DEFAULT ARRAY[]::VARCHAR(64)[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "facility_profiles_pkey" PRIMARY KEY ("provider_id")
);

-- CreateTable
CREATE TABLE "diagnostic_profiles" (
    "provider_id" UUID NOT NULL,
    "offers_pathology" BOOLEAN NOT NULL DEFAULT false,
    "offers_imaging" BOOLEAN NOT NULL DEFAULT false,
    "home_collection_available" BOOLEAN NOT NULL DEFAULT false,
    "establishment_registration_no" VARCHAR(80),
    "nabl_certificate_no" VARCHAR(80),
    "nabl_scope" VARCHAR(1000),
    "aerb_license_no" VARCHAR(80),
    "pcpndt_registration_no" VARCHAR(80),
    "typical_turnaround_hours" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "diagnostic_profiles_pkey" PRIMARY KEY ("provider_id")
);

-- CreateTable
CREATE TABLE "pharmacy_profiles" (
    "provider_id" UUID NOT NULL,
    "retail_drug_license_no" VARCHAR(80),
    "wholesale_drug_license_no" VARCHAR(80),
    "drug_license_valid_until" DATE,
    "pharmacist_name" VARCHAR(160),
    "pharmacist_registration_no" VARCHAR(80),
    "home_delivery_available" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pharmacy_profiles_pkey" PRIMARY KEY ("provider_id")
);

-- CreateTable
CREATE TABLE "ambulance_operator_profiles" (
    "provider_id" UUID NOT NULL,
    "dispatch_phone" VARCHAR(16),
    "is_open_24x7" BOOLEAN NOT NULL DEFAULT false,
    "fleet_size" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ambulance_operator_profiles_pkey" PRIMARY KEY ("provider_id")
);

-- CreateTable
CREATE TABLE "provider_locations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "region_id" UUID,
    "name" VARCHAR(160) NOT NULL,
    "address_line1" VARCHAR(200) NOT NULL,
    "address_line2" VARCHAR(200),
    "locality" VARCHAR(120),
    "city" VARCHAR(120) NOT NULL,
    "district" VARCHAR(80) NOT NULL,
    "state" VARCHAR(80) NOT NULL,
    "pincode" CHAR(6) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "phone" VARCHAR(16),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_operating_hours" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "location_id" UUID NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "opens_at_min" SMALLINT NOT NULL,
    "closes_at_min" SMALLINT NOT NULL,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "provider_operating_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_service_areas" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "district" VARCHAR(80) NOT NULL,
    "pincode" CHAR(6),
    "purpose" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_service_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_members" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "member_role" "ProviderMemberRole" NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'INVITED',
    "invited_by_id" UUID,
    "joined_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "document_type" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "storage_key" VARCHAR(300) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "document_number" VARCHAR(80),
    "issued_at" DATE,
    "expires_at" DATE,
    "uploaded_by_id" UUID,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_cases" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "kind" "VerificationCaseKind" NOT NULL DEFAULT 'ONBOARDING',
    "status" "VerificationCaseStatus" NOT NULL DEFAULT 'OPEN',
    "assigned_to_id" UUID,
    "opened_by_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verification_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_checks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "case_id" UUID NOT NULL,
    "check_type" "VerificationCheckType" NOT NULL,
    "status" "VerificationCheckStatus" NOT NULL DEFAULT 'PENDING',
    "method" "VerificationMethod" NOT NULL DEFAULT 'MANUAL_DOCUMENT_REVIEW',
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "source_reference" VARCHAR(500),
    "evidence_document_id" UUID,
    "checked_by_id" UUID,
    "checked_at" TIMESTAMPTZ(3),
    "notes" VARCHAR(2000),
    "valid_until" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_status_history" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "from_status" "ProviderStatus",
    "to_status" "ProviderStatus" NOT NULL,
    "changed_by_id" UUID,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_payout_accounts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "account_holder_name" VARCHAR(160) NOT NULL,
    "account_number_encrypted" VARCHAR(512) NOT NULL,
    "account_number_last4" CHAR(4) NOT NULL,
    "ifsc" CHAR(11) NOT NULL,
    "status" "PayoutAccountStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verified_by_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_at" TIMESTAMPTZ(3),

    CONSTRAINT "provider_payout_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_agreements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "agreement_number" VARCHAR(40) NOT NULL,
    "status" "AgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "effective_to" TIMESTAMPTZ(3),
    "signed_at" TIMESTAMPTZ(3),
    "document_id" UUID,
    "notes" VARCHAR(2000),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "provider_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "appointment_id" UUID,
    "rating" SMALLINT NOT NULL,
    "comment" VARCHAR(2000),
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING_MODERATION',
    "moderated_by_id" UUID,
    "moderated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_cases_reference_key" ON "support_cases"("reference");

-- CreateIndex
CREATE INDEX "support_cases_status_priority_created_at_idx" ON "support_cases"("status", "priority", "created_at" DESC);

-- CreateIndex
CREATE INDEX "support_cases_assigned_to_id_status_idx" ON "support_cases"("assigned_to_id", "status");

-- CreateIndex
CREATE INDEX "support_cases_provider_id_created_at_idx" ON "support_cases"("provider_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "support_cases_created_at_id_idx" ON "support_cases"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "support_case_events_case_id_created_at_idx" ON "support_case_events"("case_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_notes_subject_type_subject_id_created_at_idx" ON "admin_notes"("subject_type", "subject_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_key_channel_locale_version_key" ON "notification_templates"("key", "channel", "locale", "version");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_one_active" ON "notification_templates"("key", "channel", "locale") WHERE (is_active);

-- CreateIndex
CREATE INDEX "notifications_status_created_at_idx" ON "notifications"("status", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "export_jobs_requested_by_id_created_at_idx" ON "export_jobs"("requested_by_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "export_jobs_status_created_at_idx" ON "export_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_occurred_at_idx" ON "audit_events"("entity_type", "entity_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_occurred_at_idx" ON "audit_events"("actor_user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_action_occurred_at_idx" ON "audit_events"("action", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_occurred_at_id_idx" ON "audit_events"("occurred_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "sensitive_access_logs_resource_type_resource_id_accessed_at_idx" ON "sensitive_access_logs"("resource_type", "resource_id", "accessed_at" DESC);

-- CreateIndex
CREATE INDEX "sensitive_access_logs_actor_user_id_accessed_at_idx" ON "sensitive_access_logs"("actor_user_id", "accessed_at" DESC);

-- CreateIndex
CREATE INDEX "consent_records_patient_profile_id_scope_idx" ON "consent_records"("patient_profile_id", "scope");

-- CreateIndex
CREATE INDEX "consent_records_grantee_provider_id_idx" ON "consent_records"("grantee_provider_id");

-- CreateIndex
CREATE INDEX "legal_holds_entity_type_entity_id_idx" ON "legal_holds"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "security_incidents_reference_key" ON "security_incidents"("reference");

-- CreateIndex
CREATE INDEX "security_incidents_status_severity_idx" ON "security_incidents"("status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "specialities_code_key" ON "specialities"("code");

-- CreateIndex
CREATE UNIQUE INDEX "specialities_name_key" ON "specialities"("name");

-- CreateIndex
CREATE INDEX "specialities_parent_id_idx" ON "specialities"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "conditions_name_key" ON "conditions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "conditions_slug_key" ON "conditions"("slug");

-- CreateIndex
CREATE INDEX "conditions_name_trgm_idx" ON "conditions" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "conditions_synonyms_idx" ON "conditions" USING GIN ("synonyms");

-- CreateIndex
CREATE INDEX "condition_speciality_mappings_speciality_id_idx" ON "condition_speciality_mappings"("speciality_id");

-- CreateIndex
CREATE INDEX "condition_speciality_mappings_review_status_idx" ON "condition_speciality_mappings"("review_status");

-- CreateIndex
CREATE UNIQUE INDEX "condition_speciality_mappings_condition_id_speciality_id_key" ON "condition_speciality_mappings"("condition_id", "speciality_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE INDEX "facility_departments_department_id_is_active_idx" ON "facility_departments"("department_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "facility_departments_provider_id_department_id_key" ON "facility_departments"("provider_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "amenities_code_key" ON "amenities"("code");

-- CreateIndex
CREATE INDEX "provider_amenities_amenity_id_idx" ON "provider_amenities"("amenity_id");

-- CreateIndex
CREATE UNIQUE INDEX "services_code_key" ON "services"("code");

-- CreateIndex
CREATE INDEX "services_category_is_active_idx" ON "services"("category", "is_active");

-- CreateIndex
CREATE INDEX "services_name_trgm_idx" ON "services" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "provider_services_service_id_is_active_idx" ON "provider_services"("service_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "provider_services_provider_id_service_id_location_id_key" ON "provider_services"("provider_id", "service_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_services_providerwide_unique" ON "provider_services"("provider_id", "service_id") WHERE (location_id IS NULL);

-- CreateIndex
CREATE INDEX "medicines_name_trgm_idx" ON "medicines" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "medicines_generic_name_idx" ON "medicines"("generic_name");

-- CreateIndex
CREATE UNIQUE INDEX "medicines_name_strength_dosage_form_pack_size_manufacturer_key" ON "medicines"("name", "strength", "dosage_form", "pack_size", "manufacturer");

-- CreateIndex
CREATE UNIQUE INDEX "service_transactions_reference_key" ON "service_transactions"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "service_transactions_appointment_id_key" ON "service_transactions"("appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_transactions_diagnostic_order_id_key" ON "service_transactions"("diagnostic_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_transactions_pharmacy_order_id_key" ON "service_transactions"("pharmacy_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_transactions_dispatch_request_id_key" ON "service_transactions"("dispatch_request_id");

-- CreateIndex
CREATE INDEX "service_transactions_provider_id_created_at_idx" ON "service_transactions"("provider_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "service_transactions_status_created_at_idx" ON "service_transactions"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "service_transactions_created_at_id_idx" ON "service_transactions"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "service_transactions_service_completed_at_idx" ON "service_transactions"("service_completed_at") WHERE (commission_eligible AND service_completed_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "commission_policies_category_status_effective_from_idx" ON "commission_policies"("category", "status", "effective_from");

-- CreateIndex
CREATE INDEX "commission_policies_provider_id_status_idx" ON "commission_policies"("provider_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commission_policies_code_version_key" ON "commission_policies"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_transaction_id_idx" ON "payments"("transaction_id");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payments_gateway_gateway_order_id_key" ON "payments"("gateway", "gateway_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_gateway_gateway_payment_id_key" ON "payments"("gateway", "gateway_payment_id");

-- CreateIndex
CREATE INDEX "payment_webhook_events_processing_status_received_at_idx" ON "payment_webhook_events"("processing_status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_gateway_event_id_key" ON "payment_webhook_events"("gateway", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_reference_key" ON "refunds"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_gateway_refund_id_key" ON "refunds"("gateway_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX "refunds_transaction_id_idx" ON "refunds"("transaction_id");

-- CreateIndex
CREATE INDEX "refunds_status_created_at_idx" ON "refunds"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "commission_snapshots_policy_id_idx" ON "commission_snapshots"("policy_id");

-- CreateIndex
CREATE INDEX "commission_snapshots_calculated_at_idx" ON "commission_snapshots"("calculated_at");

-- CreateIndex
CREATE UNIQUE INDEX "commission_snapshots_one_live" ON "commission_snapshots"("transaction_id") WHERE (status <> 'REVERSED');

-- CreateIndex
CREATE UNIQUE INDEX "provider_ledger_entries_dedupe_key_key" ON "provider_ledger_entries"("dedupe_key");

-- CreateIndex
CREATE INDEX "provider_ledger_entries_provider_id_created_at_idx" ON "provider_ledger_entries"("provider_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_unsettled_by_provider" ON "provider_ledger_entries"("provider_id") WHERE (settlement_item_id IS NULL);

-- CreateIndex
CREATE INDEX "provider_ledger_entries_transaction_id_idx" ON "provider_ledger_entries"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batches_reference_key" ON "settlement_batches"("reference");

-- CreateIndex
CREATE INDEX "settlement_batches_status_created_at_idx" ON "settlement_batches"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "settlement_items_payout_reference_key" ON "settlement_items"("payout_reference");

-- CreateIndex
CREATE INDEX "settlement_items_provider_id_status_idx" ON "settlement_items"("provider_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_items_batch_id_provider_id_key" ON "settlement_items"("batch_id", "provider_id");

-- CreateIndex
CREATE INDEX "reconciliation_records_run_id_idx" ON "reconciliation_records"("run_id");

-- CreateIndex
CREATE INDEX "reconciliation_records_status_created_at_idx" ON "reconciliation_records"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_user_id_scope_key_key" ON "idempotency_records"("user_id", "scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_status_created_at_idx" ON "users"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "users_created_at_id_idx" ON "users"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "users_full_name_trgm_idx" ON "users" USING GIN ("full_name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_active_unique" ON "user_roles"("user_id", "role_id") WHERE (revoked_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_family_id_idx" ON "sessions"("family_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "login_attempts_identifier_hash_created_at_idx" ON "login_attempts"("identifier_hash", "created_at" DESC);

-- CreateIndex
CREATE INDEX "login_attempts_user_id_created_at_idx" ON "login_attempts"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "login_attempts_created_at_idx" ON "login_attempts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_hash_key" ON "verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "verification_tokens_user_id_purpose_idx" ON "verification_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "doctor_affiliations_facility_provider_id_status_idx" ON "doctor_affiliations"("facility_provider_id", "status");

-- CreateIndex
CREATE INDEX "doctor_affiliations_doctor_provider_id_status_idx" ON "doctor_affiliations"("doctor_provider_id", "status");

-- CreateIndex
CREATE INDEX "doctor_affiliations_status_created_at_idx" ON "doctor_affiliations"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_affiliations_one_live" ON "doctor_affiliations"("doctor_provider_id", "facility_provider_id") WHERE (status = ANY (ARRAY['INVITED'::"AffiliationStatus", 'REQUESTED'::"AffiliationStatus", 'PENDING_VERIFICATION'::"AffiliationStatus", 'ACTIVE'::"AffiliationStatus", 'SUSPENDED'::"AffiliationStatus"]));

-- CreateIndex
CREATE INDEX "affiliation_events_affiliation_id_created_at_idx" ON "affiliation_events"("affiliation_id", "created_at");

-- CreateIndex
CREATE INDEX "doctor_schedules_doctor_provider_id_is_active_idx" ON "doctor_schedules"("doctor_provider_id", "is_active");

-- CreateIndex
CREATE INDEX "appointment_slots_location_id_starts_at_idx" ON "appointment_slots"("location_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_slots_open_by_doctor" ON "appointment_slots"("doctor_provider_id", "starts_at") WHERE (status = 'OPEN');

-- CreateIndex
CREATE UNIQUE INDEX "appointment_slots_doctor_provider_id_location_id_starts_at_key" ON "appointment_slots"("doctor_provider_id", "location_id", "starts_at");

-- CreateIndex
CREATE INDEX "patient_profiles_account_user_id_idx" ON "patient_profiles"("account_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_profiles_one_self" ON "patient_profiles"("account_user_id") WHERE (relationship = 'SELF');

-- CreateIndex
CREATE UNIQUE INDEX "appointments_reference_key" ON "appointments"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_rescheduled_from_id_key" ON "appointments"("rescheduled_from_id");

-- CreateIndex
CREATE INDEX "appointments_doctor_provider_id_created_at_idx" ON "appointments"("doctor_provider_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "appointments_facility_provider_id_created_at_idx" ON "appointments"("facility_provider_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "appointments_status_created_at_idx" ON "appointments"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "appointments_patient_profile_id_created_at_idx" ON "appointments"("patient_profile_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "appointments_created_at_id_idx" ON "appointments"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "appointments_slot_id_idx" ON "appointments"("slot_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_booked_by_user_id_idempotency_key_key" ON "appointments"("booked_by_user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_patient_slot_live" ON "appointments"("patient_profile_id", "slot_id") WHERE (status = ANY (ARRAY['REQUESTED'::"AppointmentStatus", 'CONFIRMED'::"AppointmentStatus", 'CHECKED_IN'::"AppointmentStatus"]));

-- CreateIndex
CREATE INDEX "appointment_events_appointment_id_created_at_idx" ON "appointment_events"("appointment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "diagnostic_orders_reference_key" ON "diagnostic_orders"("reference");

-- CreateIndex
CREATE INDEX "diagnostic_orders_provider_id_created_at_idx" ON "diagnostic_orders"("provider_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "diagnostic_orders_status_created_at_idx" ON "diagnostic_orders"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "diagnostic_orders_patient_profile_id_created_at_idx" ON "diagnostic_orders"("patient_profile_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "diagnostic_orders_booked_by_user_id_idempotency_key_key" ON "diagnostic_orders"("booked_by_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "diagnostic_order_items_order_id_idx" ON "diagnostic_order_items"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "diagnostic_reports_storage_key_key" ON "diagnostic_reports"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "diagnostic_reports_supersedes_id_key" ON "diagnostic_reports"("supersedes_id");

-- CreateIndex
CREATE UNIQUE INDEX "diagnostic_reports_order_id_version_key" ON "diagnostic_reports"("order_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "prescriptions_storage_key_key" ON "prescriptions"("storage_key");

-- CreateIndex
CREATE INDEX "prescriptions_patient_profile_id_created_at_idx" ON "prescriptions"("patient_profile_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pharmacy_inventory_medicine_id_expiry_date_idx" ON "pharmacy_inventory"("medicine_id", "expiry_date");

-- CreateIndex
CREATE INDEX "pharmacy_inventory_provider_id_idx" ON "pharmacy_inventory"("provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_inventory_location_id_medicine_id_batch_number_key" ON "pharmacy_inventory"("location_id", "medicine_id", "batch_number");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_orders_reference_key" ON "pharmacy_orders"("reference");

-- CreateIndex
CREATE INDEX "pharmacy_orders_provider_id_created_at_idx" ON "pharmacy_orders"("provider_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pharmacy_orders_status_created_at_idx" ON "pharmacy_orders"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_orders_booked_by_user_id_idempotency_key_key" ON "pharmacy_orders"("booked_by_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "pharmacy_order_items_order_id_idx" ON "pharmacy_order_items"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "ambulance_vehicles_registration_number_key" ON "ambulance_vehicles"("registration_number");

-- CreateIndex
CREATE INDEX "ambulance_vehicles_operator_provider_id_status_idx" ON "ambulance_vehicles"("operator_provider_id", "status");

-- CreateIndex
CREATE INDEX "ambulance_crew_members_operator_provider_id_idx" ON "ambulance_crew_members"("operator_provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_requests_reference_key" ON "dispatch_requests"("reference");

-- CreateIndex
CREATE INDEX "dispatch_requests_status_created_at_idx" ON "dispatch_requests"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "dispatch_requests_mode_created_at_idx" ON "dispatch_requests"("mode", "created_at" DESC);

-- CreateIndex
CREATE INDEX "dispatch_assignments_request_id_idx" ON "dispatch_assignments"("request_id");

-- CreateIndex
CREATE INDEX "dispatch_assignments_vehicle_id_status_idx" ON "dispatch_assignments"("vehicle_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_assignments_one_accepted" ON "dispatch_assignments"("request_id") WHERE (status = 'ACCEPTED');

-- CreateIndex
CREATE INDEX "dispatch_events_request_id_created_at_idx" ON "dispatch_events"("request_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "service_regions_code_key" ON "service_regions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "providers_slug_key" ON "providers"("slug");

-- CreateIndex
CREATE INDEX "providers_type_status_created_at_idx" ON "providers"("type", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "providers_status_created_at_idx" ON "providers"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "providers_created_at_id_idx" ON "providers"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "providers_display_name_trgm_idx" ON "providers" USING GIN ("display_name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "providers_gstin_idx" ON "providers"("gstin") WHERE (gstin IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "doctor_profiles_user_id_key" ON "doctor_profiles"("user_id");

-- CreateIndex
CREATE INDEX "doctor_specialities_speciality_id_idx" ON "doctor_specialities"("speciality_id");

-- CreateIndex
CREATE INDEX "doctor_qualifications_doctor_provider_id_idx" ON "doctor_qualifications"("doctor_provider_id");

-- CreateIndex
CREATE INDEX "professional_registrations_doctor_provider_id_idx" ON "professional_registrations"("doctor_provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "professional_registrations_council_registration_number_key" ON "professional_registrations"("council", "registration_number");

-- CreateIndex
CREATE INDEX "provider_locations_provider_id_idx" ON "provider_locations"("provider_id");

-- CreateIndex
CREATE INDEX "provider_locations_region_id_idx" ON "provider_locations"("region_id");

-- CreateIndex
CREATE INDEX "provider_locations_district_pincode_idx" ON "provider_locations"("district", "pincode");

-- CreateIndex
CREATE INDEX "provider_locations_latitude_longitude_idx" ON "provider_locations"("latitude", "longitude") WHERE (is_active AND latitude IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "provider_locations_one_primary" ON "provider_locations"("provider_id") WHERE (is_primary);

-- CreateIndex
CREATE UNIQUE INDEX "provider_operating_hours_location_id_day_of_week_opens_at_m_key" ON "provider_operating_hours"("location_id", "day_of_week", "opens_at_min");

-- CreateIndex
CREATE INDEX "provider_service_areas_district_pincode_purpose_idx" ON "provider_service_areas"("district", "pincode", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "provider_service_areas_provider_id_purpose_district_pincode_key" ON "provider_service_areas"("provider_id", "purpose", "district", "pincode");

-- CreateIndex
CREATE INDEX "provider_members_user_id_idx" ON "provider_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_members_provider_id_user_id_key" ON "provider_members"("provider_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_documents_storage_key_key" ON "provider_documents"("storage_key");

-- CreateIndex
CREATE INDEX "provider_documents_provider_id_document_type_idx" ON "provider_documents"("provider_id", "document_type");

-- CreateIndex
CREATE INDEX "provider_documents_expires_at_idx" ON "provider_documents"("expires_at") WHERE (status = 'ACCEPTED' AND expires_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "provider_documents_status_created_at_idx" ON "provider_documents"("status", "created_at");

-- CreateIndex
CREATE INDEX "verification_cases_status_created_at_idx" ON "verification_cases"("status", "created_at");

-- CreateIndex
CREATE INDEX "verification_cases_assigned_to_id_status_idx" ON "verification_cases"("assigned_to_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "verification_cases_one_open_per_provider" ON "verification_cases"("provider_id") WHERE (status = ANY (ARRAY['OPEN'::"VerificationCaseStatus", 'IN_REVIEW'::"VerificationCaseStatus", 'AWAITING_PROVIDER'::"VerificationCaseStatus"]));

-- CreateIndex
CREATE UNIQUE INDEX "verification_checks_case_id_check_type_key" ON "verification_checks"("case_id", "check_type");

-- CreateIndex
CREATE INDEX "provider_status_history_provider_id_created_at_idx" ON "provider_status_history"("provider_id", "created_at");

-- CreateIndex
CREATE INDEX "provider_payout_accounts_provider_id_idx" ON "provider_payout_accounts"("provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_accounts_one_verified" ON "provider_payout_accounts"("provider_id") WHERE (status = 'VERIFIED');

-- CreateIndex
CREATE UNIQUE INDEX "provider_agreements_agreement_number_key" ON "provider_agreements"("agreement_number");

-- CreateIndex
CREATE INDEX "provider_agreements_provider_id_status_idx" ON "provider_agreements"("provider_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_appointment_id_key" ON "reviews"("appointment_id");

-- CreateIndex
CREATE INDEX "reviews_provider_id_status_created_at_idx" ON "reviews"("provider_id", "status", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "service_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_case_events" ADD CONSTRAINT "support_case_events_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "support_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_patient_profile_id_fkey" FOREIGN KEY ("patient_profile_id") REFERENCES "patient_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialities" ADD CONSTRAINT "specialities_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "specialities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "condition_speciality_mappings" ADD CONSTRAINT "condition_speciality_mappings_condition_id_fkey" FOREIGN KEY ("condition_id") REFERENCES "conditions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "condition_speciality_mappings" ADD CONSTRAINT "condition_speciality_mappings_speciality_id_fkey" FOREIGN KEY ("speciality_id") REFERENCES "specialities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_speciality_id_fkey" FOREIGN KEY ("speciality_id") REFERENCES "specialities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facility_departments" ADD CONSTRAINT "facility_departments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facility_departments" ADD CONSTRAINT "facility_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_amenities" ADD CONSTRAINT "provider_amenities_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_amenities" ADD CONSTRAINT "provider_amenities_amenity_id_fkey" FOREIGN KEY ("amenity_id") REFERENCES "amenities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_speciality_id_fkey" FOREIGN KEY ("speciality_id") REFERENCES "specialities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_panel_items" ADD CONSTRAINT "service_panel_items_panel_id_fkey" FOREIGN KEY ("panel_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_panel_items" ADD CONSTRAINT "service_panel_items_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_services" ADD CONSTRAINT "provider_services_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_services" ADD CONSTRAINT "provider_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_services" ADD CONSTRAINT "provider_services_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "provider_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_transactions" ADD CONSTRAINT "service_transactions_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_transactions" ADD CONSTRAINT "service_transactions_diagnostic_order_id_fkey" FOREIGN KEY ("diagnostic_order_id") REFERENCES "diagnostic_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_transactions" ADD CONSTRAINT "service_transactions_pharmacy_order_id_fkey" FOREIGN KEY ("pharmacy_order_id") REFERENCES "pharmacy_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_transactions" ADD CONSTRAINT "service_transactions_dispatch_request_id_fkey" FOREIGN KEY ("dispatch_request_id") REFERENCES "dispatch_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_transactions" ADD CONSTRAINT "service_transactions_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_transactions" ADD CONSTRAINT "service_transactions_patient_profile_id_fkey" FOREIGN KEY ("patient_profile_id") REFERENCES "patient_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_policies" ADD CONSTRAINT "commission_policies_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_policies" ADD CONSTRAINT "commission_policies_agreement_id_fkey" FOREIGN KEY ("agreement_id") REFERENCES "provider_agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "service_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "service_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_snapshots" ADD CONSTRAINT "commission_snapshots_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "service_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_snapshots" ADD CONSTRAINT "commission_snapshots_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "commission_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_ledger_entries" ADD CONSTRAINT "provider_ledger_entries_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_ledger_entries" ADD CONSTRAINT "provider_ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "service_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_ledger_entries" ADD CONSTRAINT "provider_ledger_entries_settlement_item_id_fkey" FOREIGN KEY ("settlement_item_id") REFERENCES "settlement_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "settlement_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_affiliations" ADD CONSTRAINT "doctor_affiliations_doctor_provider_id_fkey" FOREIGN KEY ("doctor_provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_affiliations" ADD CONSTRAINT "doctor_affiliations_facility_provider_id_fkey" FOREIGN KEY ("facility_provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_affiliations" ADD CONSTRAINT "doctor_affiliations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "provider_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_affiliations" ADD CONSTRAINT "doctor_affiliations_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliation_events" ADD CONSTRAINT "affiliation_events_affiliation_id_fkey" FOREIGN KEY ("affiliation_id") REFERENCES "doctor_affiliations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_doctor_provider_id_fkey" FOREIGN KEY ("doctor_provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "provider_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_affiliation_id_fkey" FOREIGN KEY ("affiliation_id") REFERENCES "doctor_affiliations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_slots" ADD CONSTRAINT "appointment_slots_doctor_provider_id_fkey" FOREIGN KEY ("doctor_provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_slots" ADD CONSTRAINT "appointment_slots_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "provider_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_slots" ADD CONSTRAINT "appointment_slots_affiliation_id_fkey" FOREIGN KEY ("affiliation_id") REFERENCES "doctor_affiliations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_slots" ADD CONSTRAINT "appointment_slots_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "doctor_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_profiles" ADD CONSTRAINT "patient_profiles_account_user_id_fkey" FOREIGN KEY ("account_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_profile_id_fkey" FOREIGN KEY ("patient_profile_id") REFERENCES "patient_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_provider_id_fkey" FOREIGN KEY ("doctor_provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_facility_provider_id_fkey" FOREIGN KEY ("facility_provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "provider_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "appointment_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_affiliation_id_fkey" FOREIGN KEY ("affiliation_id") REFERENCES "doctor_affiliations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rescheduled_from_id_fkey" FOREIGN KEY ("rescheduled_from_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_orders" ADD CONSTRAINT "diagnostic_orders_patient_profile_id_fkey" FOREIGN KEY ("patient_profile_id") REFERENCES "patient_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_orders" ADD CONSTRAINT "diagnostic_orders_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_orders" ADD CONSTRAINT "diagnostic_orders_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_order_items" ADD CONSTRAINT "diagnostic_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "diagnostic_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_order_items" ADD CONSTRAINT "diagnostic_order_items_provider_service_id_fkey" FOREIGN KEY ("provider_service_id") REFERENCES "provider_services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_reports" ADD CONSTRAINT "diagnostic_reports_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "diagnostic_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_reports" ADD CONSTRAINT "diagnostic_reports_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "diagnostic_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_patient_profile_id_fkey" FOREIGN KEY ("patient_profile_id") REFERENCES "patient_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_inventory" ADD CONSTRAINT "pharmacy_inventory_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_inventory" ADD CONSTRAINT "pharmacy_inventory_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "provider_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_inventory" ADD CONSTRAINT "pharmacy_inventory_medicine_id_fkey" FOREIGN KEY ("medicine_id") REFERENCES "medicines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_orders" ADD CONSTRAINT "pharmacy_orders_patient_profile_id_fkey" FOREIGN KEY ("patient_profile_id") REFERENCES "patient_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_orders" ADD CONSTRAINT "pharmacy_orders_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_orders" ADD CONSTRAINT "pharmacy_orders_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_order_items" ADD CONSTRAINT "pharmacy_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "pharmacy_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_order_items" ADD CONSTRAINT "pharmacy_order_items_medicine_id_fkey" FOREIGN KEY ("medicine_id") REFERENCES "medicines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_order_items" ADD CONSTRAINT "pharmacy_order_items_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "pharmacy_inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ambulance_vehicles" ADD CONSTRAINT "ambulance_vehicles_operator_provider_id_fkey" FOREIGN KEY ("operator_provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ambulance_vehicles" ADD CONSTRAINT "ambulance_vehicles_base_location_id_fkey" FOREIGN KEY ("base_location_id") REFERENCES "provider_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ambulance_crew_members" ADD CONSTRAINT "ambulance_crew_members_operator_provider_id_fkey" FOREIGN KEY ("operator_provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_assignments" ADD CONSTRAINT "dispatch_assignments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "dispatch_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_assignments" ADD CONSTRAINT "dispatch_assignments_operator_provider_id_fkey" FOREIGN KEY ("operator_provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_assignments" ADD CONSTRAINT "dispatch_assignments_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "ambulance_vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_events" ADD CONSTRAINT "dispatch_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "dispatch_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_specialities" ADD CONSTRAINT "doctor_specialities_doctor_provider_id_fkey" FOREIGN KEY ("doctor_provider_id") REFERENCES "doctor_profiles"("provider_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_specialities" ADD CONSTRAINT "doctor_specialities_speciality_id_fkey" FOREIGN KEY ("speciality_id") REFERENCES "specialities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_qualifications" ADD CONSTRAINT "doctor_qualifications_doctor_provider_id_fkey" FOREIGN KEY ("doctor_provider_id") REFERENCES "doctor_profiles"("provider_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_registrations" ADD CONSTRAINT "professional_registrations_doctor_provider_id_fkey" FOREIGN KEY ("doctor_provider_id") REFERENCES "doctor_profiles"("provider_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facility_profiles" ADD CONSTRAINT "facility_profiles_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_profiles" ADD CONSTRAINT "diagnostic_profiles_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_profiles" ADD CONSTRAINT "pharmacy_profiles_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ambulance_operator_profiles" ADD CONSTRAINT "ambulance_operator_profiles_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_locations" ADD CONSTRAINT "provider_locations_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_locations" ADD CONSTRAINT "provider_locations_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "service_regions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_operating_hours" ADD CONSTRAINT "provider_operating_hours_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "provider_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_service_areas" ADD CONSTRAINT "provider_service_areas_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_members" ADD CONSTRAINT "provider_members_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_members" ADD CONSTRAINT "provider_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_documents" ADD CONSTRAINT "provider_documents_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_cases" ADD CONSTRAINT "verification_cases_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_checks" ADD CONSTRAINT "verification_checks_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "verification_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_checks" ADD CONSTRAINT "verification_checks_evidence_document_id_fkey" FOREIGN KEY ("evidence_document_id") REFERENCES "provider_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_status_history" ADD CONSTRAINT "provider_status_history_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_payout_accounts" ADD CONSTRAINT "provider_payout_accounts_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_agreements" ADD CONSTRAINT "provider_agreements_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

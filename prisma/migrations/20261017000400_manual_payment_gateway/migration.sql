-- Offline money recorded by finance staff (bank transfer / UPI to the platform account / cash deposit).
-- The value is not used in this migration, so it is safe inside the migration transaction.
ALTER TYPE "PaymentGateway" ADD VALUE IF NOT EXISTS 'MANUAL';

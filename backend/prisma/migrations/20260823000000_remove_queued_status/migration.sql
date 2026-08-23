-- Migrate any existing queued emails into the scheduled state before removing the enum value.
UPDATE "scheduled_emails"
SET "status" = 'SCHEDULED'
WHERE "status" = 'QUEUED';

-- This migration is safe because the enum values are only used by this app and the queued state is being removed intentionally.
ALTER TYPE "EmailStatus" RENAME TO "EmailStatus_old";

CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED', 'SCHEDULED');

ALTER TABLE "scheduled_emails"
  ALTER COLUMN "status" TYPE "EmailStatus"
  USING (
    CASE "status"
      WHEN 'PENDING' THEN 'PENDING'::"EmailStatus"
      WHEN 'PROCESSING' THEN 'PROCESSING'::"EmailStatus"
      WHEN 'SENT' THEN 'SENT'::"EmailStatus"
      WHEN 'FAILED' THEN 'FAILED'::"EmailStatus"
      WHEN 'CANCELLED' THEN 'CANCELLED'::"EmailStatus"
      WHEN 'SCHEDULED' THEN 'SCHEDULED'::"EmailStatus"
      ELSE 'SCHEDULED'::"EmailStatus"
    END
  );

DROP TYPE "EmailStatus_old";

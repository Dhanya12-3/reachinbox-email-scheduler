-- Existing failed/in-flight records remain visible as scheduled demo emails.
UPDATE "scheduled_emails"
SET "status" = 'SCHEDULED'
WHERE "status" = 'FAILED';

ALTER TYPE "EmailStatus" RENAME TO "EmailStatus_old";
CREATE TYPE "EmailStatus" AS ENUM ('SCHEDULED', 'SENT');

ALTER TABLE "scheduled_emails"
  ALTER COLUMN "status" TYPE "EmailStatus"
  USING "status"::text::"EmailStatus";

ALTER TABLE "scheduled_emails"
  DROP COLUMN IF EXISTS "attempts",
  DROP COLUMN IF EXISTS "error",
  DROP COLUMN IF EXISTS "processingAt";

DROP TYPE "EmailStatus_old";
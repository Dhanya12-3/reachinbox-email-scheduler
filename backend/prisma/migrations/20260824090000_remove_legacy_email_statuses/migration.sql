-- Normalize legacy states before restricting the status enum to the delivery lifecycle.
UPDATE "scheduled_emails"
SET "status" = 'SCHEDULED',
    "processingAt" = NULL
WHERE "status" IN ('PENDING', 'PROCESSING', 'CANCELLED');

ALTER TYPE "EmailStatus" RENAME TO "EmailStatus_old";

CREATE TYPE "EmailStatus" AS ENUM ('SCHEDULED', 'SENT', 'FAILED');

ALTER TABLE "scheduled_emails"
  ALTER COLUMN "status" TYPE "EmailStatus"
  USING "status"::text::"EmailStatus";

DROP TYPE "EmailStatus_old";

ALTER TABLE "campaigns" DROP COLUMN IF EXISTS "hourlyLimit";
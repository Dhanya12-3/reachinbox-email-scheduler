-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('SCHEDULED', 'PROCESSING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "Email" (
    "id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "status" "EmailStatus" NOT NULL DEFAULT 'SCHEDULED',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Email_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Email_status_scheduledAt_idx" ON "Email"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Email_sender_scheduledAt_idx" ON "Email"("sender", "scheduledAt");

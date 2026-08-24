-- AlterTable: add payment processing fields to Transaction
ALTER TABLE "Transaction" ADD COLUMN "memo" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "submittedAt" TIMESTAMP(3);

-- CreateIndex
-- Partial index: errorCode is NULL for every successful payment, so index
-- only failure rows. Kept non-concurrent — Prisma runs migrations inside a
-- transaction and this table is new/small; build out of band with
-- CONCURRENTLY if it grows large before this ships.
CREATE INDEX "Transaction_errorCode_idx" ON "Transaction"("errorCode") WHERE "errorCode" IS NOT NULL;

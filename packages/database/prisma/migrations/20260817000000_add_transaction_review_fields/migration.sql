-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "flagReviewAction" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "resolvedBy" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "resolvedAt" TIMESTAMP(3);
ALTER TABLE "Transaction" ADD COLUMN "resolutionNote" TEXT;

-- AlterTable
ALTER TABLE "ComplianceAlert" ADD COLUMN "ruleId" TEXT;

-- CreateIndex
CREATE INDEX "Transaction_flagReviewAction_idx" ON "Transaction"("flagReviewAction");

-- CreateIndex
CREATE INDEX "ComplianceAlert_ruleId_idx" ON "ComplianceAlert"("ruleId");
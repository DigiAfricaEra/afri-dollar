-- AlterTable: add payment processing fields to Transaction
ALTER TABLE "Transaction" ADD COLUMN "memo" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "submittedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Transaction_errorCode_idx" ON "Transaction"("errorCode");

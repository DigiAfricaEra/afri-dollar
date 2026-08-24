-- AlterTable: add payment processing fields to Transaction
ALTER TABLE "Transaction" ADD COLUMN "memo" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "submittedAt" TIMESTAMP(3);

-- CreateIndex
-- Plain index declared in schema.prisma (@@index([errorCode])) so Prisma
-- drift detection stays consistent — Prisma 5.x cannot model partial-index
-- predicates.
CREATE INDEX "Transaction_errorCode_idx" ON "Transaction"("errorCode");

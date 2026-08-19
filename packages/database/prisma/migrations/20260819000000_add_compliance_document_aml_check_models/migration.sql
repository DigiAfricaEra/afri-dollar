-- CreateEnum
CREATE TYPE "KYCLevel" AS ENUM ('BASIC', 'STANDARD', 'ENHANCED');

-- AlterTable: KYCRecord additions
ALTER TABLE "KYCRecord" ADD COLUMN "level" "KYCLevel" NOT NULL DEFAULT 'BASIC';
ALTER TABLE "KYCRecord" ADD COLUMN "providerData" JSONB;
ALTER TABLE "KYCRecord" ADD COLUMN "rejectionCode" TEXT;
ALTER TABLE "KYCRecord" ADD COLUMN "reviewerId" TEXT;

-- CreateIndex for new KYCRecord column
CREATE INDEX "KYCRecord_level_idx" ON "KYCRecord"("level");

-- CreateTable: ComplianceDocument
CREATE TABLE "ComplianceDocument" (
    "id" TEXT NOT NULL,
    "kycRecordId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "fileName" TEXT,
    "fileUrl" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex for ComplianceDocument
CREATE INDEX "ComplianceDocument_kycRecordId_idx" ON "ComplianceDocument"("kycRecordId");

-- AddForeignKey: ComplianceDocument -> KYCRecord
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_kycRecordId_fkey"
    FOREIGN KEY ("kycRecordId") REFERENCES "KYCRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: AMLCheck
CREATE TABLE "AMLCheck" (
    "id" TEXT NOT NULL,
    "kycRecordId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "screeningType" TEXT NOT NULL,
    "matches" JSONB NOT NULL DEFAULT '[]',
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" TEXT NOT NULL DEFAULT 'low',
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AMLCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex for AMLCheck
CREATE INDEX "AMLCheck_userId_idx" ON "AMLCheck"("userId");
CREATE INDEX "AMLCheck_kycRecordId_idx" ON "AMLCheck"("kycRecordId");
CREATE INDEX "AMLCheck_riskLevel_idx" ON "AMLCheck"("riskLevel");
CREATE INDEX "AMLCheck_resolved_idx" ON "AMLCheck"("resolved");

-- AddForeignKey: AMLCheck -> KYCRecord
ALTER TABLE "AMLCheck" ADD CONSTRAINT "AMLCheck_kycRecordId_fkey"
    FOREIGN KEY ("kycRecordId") REFERENCES "KYCRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: ComplianceAlert additions
ALTER TABLE "ComplianceAlert" ADD COLUMN "kycRecordId" TEXT;

-- CreateIndex for new ComplianceAlert column
CREATE INDEX "ComplianceAlert_kycRecordId_idx" ON "ComplianceAlert"("kycRecordId");

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('transaction_history', 'compliance_report', 'financial_statement', 'payroll_report', 'treasury_report', 'audit_log');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('csv', 'pdf', 'xlsx');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('pending', 'generating', 'completed', 'failed');

-- AlterTable: ReportRequest - change column types to enums
ALTER TABLE "ReportRequest" 
  ALTER COLUMN "reportType" SET DATA TYPE "ReportType" USING "reportType"::text::"ReportType",
  ALTER COLUMN "format" SET DATA TYPE "ReportFormat" USING "format"::text::"ReportFormat",
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" SET DATA TYPE "ReportStatus" USING "status"::text::"ReportStatus",
  ALTER COLUMN "status" SET DEFAULT 'pending';

-- AlterTable: ReportTemplate - change column types to enums
ALTER TABLE "ReportTemplate"
  ALTER COLUMN "reportType" SET DATA TYPE "ReportType" USING "reportType"::text::"ReportType",
  ALTER COLUMN "format" SET DATA TYPE "ReportFormat" USING "format"::text::"ReportFormat";

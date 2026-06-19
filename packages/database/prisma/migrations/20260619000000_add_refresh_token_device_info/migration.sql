-- AlterTable: add deviceInfo to RefreshToken for device-scoped token management
ALTER TABLE "RefreshToken" ADD COLUMN "deviceInfo" TEXT;

-- CreateIndex: composite index for device-scoped token lookups
CREATE INDEX "RefreshToken_userId_deviceInfo_idx" ON "RefreshToken"("userId", "deviceInfo");

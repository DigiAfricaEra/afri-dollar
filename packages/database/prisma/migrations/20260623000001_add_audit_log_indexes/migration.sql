-- DropIndex: redundant single-column indexes (covered by composite indexes)
DROP INDEX IF EXISTS "AuditLog_userId_idx";
DROP INDEX IF EXISTS "AuditLog_action_idx";

-- CreateIndex: composite index for action-based audit log queries
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex: composite index for user-based audit log queries
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

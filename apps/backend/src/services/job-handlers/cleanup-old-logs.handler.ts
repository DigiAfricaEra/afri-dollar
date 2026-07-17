import prisma from '../../config/database';

const AUDIT_LOG_RETENTION_DAYS = 90;

export async function cleanupOldLogs(): Promise<void> {
  const cutoff = new Date(Date.now() - AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  await prisma.auditLog.deleteMany({
    where: {
      createdAt: {
        lt: cutoff,
      },
    },
  });
}

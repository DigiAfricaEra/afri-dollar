import prisma from '../../config/database';

const AUDIT_LOG_RETENTION_DAYS = 90;
const CLEANUP_BATCH_SIZE = 500;

export async function cleanupOldLogs(): Promise<void> {
  const cutoff = new Date(Date.now() - AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let hasExpiredLogs = true;

  while (hasExpiredLogs) {
    const expiredLogs = await prisma.auditLog.findMany({
      where: {
        createdAt: {
          lt: cutoff,
        },
      },
      select: {
        id: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: CLEANUP_BATCH_SIZE,
    });

    if (expiredLogs.length === 0) {
      hasExpiredLogs = false;
      continue;
    }

    await prisma.auditLog.deleteMany({
      where: {
        id: {
          in: expiredLogs.map((log) => log.id),
        },
      },
    });
  }
}

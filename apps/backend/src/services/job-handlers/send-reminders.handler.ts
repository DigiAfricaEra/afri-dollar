import prisma from '../../config/database';

export async function sendReminders(): Promise<void> {
  await prisma.transaction.findMany({
    where: {
      status: { in: ['created', 'pending'] },
      metadata: {
        path: ['paymentType'],
        equals: 'cross_border',
      },
    },
    take: 100,
  });
  // TODO: Send reminders when notification/email service APIs are available.
}

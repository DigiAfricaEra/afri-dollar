import prisma from '../../config/database';

export async function processPendingPayments(): Promise<void> {
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
  // TODO: Process each pending payment when a system-owned payment processing
  // context is available. PaymentService.processPayment currently requires a user id.
}

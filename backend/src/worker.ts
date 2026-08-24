import { Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import env from './config';
import { connection, EmailJob, QUEUE_NAME } from './queue';

const prisma = new PrismaClient();

let worker: Worker<EmailJob> | undefined;

export function startWorker() {
  if (worker) return worker;

  worker = new Worker<EmailJob>(QUEUE_NAME, async job => {
    const email = await prisma.scheduledEmail.findFirst({
      where: {
        id: job.data.scheduledEmailId,
        scheduledAt: { lte: new Date() },
        status: 'SCHEDULED',
      },
      select: { id: true },
    });

    if (!email) {
      console.log(`[EMAIL] skipping already completed demo email ${job.data.scheduledEmailId}`);
      return;
    }

    console.log(`[EMAIL] demo send ${email.id}`);
    const result = await prisma.scheduledEmail.updateMany({
      where: { id: email.id, status: 'SCHEDULED' },
      data: { status: 'SENT', sentAt: new Date() },
    });

    if (result.count === 1) console.log(`[EMAIL] status updated to SENT ${email.id}`);
  }, { connection, concurrency: env.WORKER_CONCURRENCY, maxStalledCount: 1 });

  worker.on('ready', () => console.log(`Email worker ready on queue ${QUEUE_NAME} with concurrency ${env.WORKER_CONCURRENCY}`));
  worker.on('error', error => console.error(`BullMQ worker error (${QUEUE_NAME}): ${error.message}`));
  worker.on('failed', (job, error) => {
    console.error(`Demo email job failed for ${job?.data.scheduledEmailId ?? 'unknown'}: ${error.message}`);
  });

  return worker;
}

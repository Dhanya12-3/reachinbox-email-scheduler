import { Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import env from './config';
import { connection, EmailJob, QUEUE_NAME } from './queue';
import { sendEmail } from './mailer';

const prisma = new PrismaClient();

async function claim(id: string) {
  const result = await prisma.scheduledEmail.updateMany({
    where: {
      id,
      scheduledAt: { lte: new Date() },
      status: 'SCHEDULED',
      processingAt: null,
    },
    data: {
      processingAt: new Date(),
      attempts: { increment: 1 },
    },
  });
  return result.count === 1;
}

let worker: Worker<EmailJob> | undefined;

export function startWorker() {
  if (worker) return worker;

  worker = new Worker<EmailJob>(QUEUE_NAME, async job => {
    console.log(`[DEBUG] JOB RECEIVED ${job.data.scheduledEmailId}`);

    const beforeClaim = await prisma.scheduledEmail.findUnique({
      where: { id: job.data.scheduledEmailId },
      select: { status: true },
    });
    console.log(`[DEBUG] CURRENT DB STATUS ${job.data.scheduledEmailId} = ${beforeClaim?.status ?? 'MISSING'}`);

    if (!(await claim(job.data.scheduledEmailId))) {
      console.log(`[DEBUG] CLAIM RESULT ${job.data.scheduledEmailId} = false`);
      const existing = await prisma.scheduledEmail.findUnique({
        where: { id: job.data.scheduledEmailId },
        select: { status: true },
      });
      if (existing?.status === 'SENT') console.log(`Skipping already sent email ${job.data.scheduledEmailId}`);
      return;
    }

    console.log(`[DEBUG] CLAIM RESULT ${job.data.scheduledEmailId} = true`);
    console.log(`Email processing: ${job.data.scheduledEmailId}`);

    try {
      const email = await prisma.scheduledEmail.findUniqueOrThrow({
        where: { id: job.data.scheduledEmailId },
        include: { campaign: true },
      });

      console.log(`[DEBUG] ABOUT TO CALL sendEmail ${email.id}`);
      console.log(`[EMAIL] sending ${email.id}`);

      const preview = await sendEmail({
        id: email.id,
        recipient: email.recipientEmail,
        sender: job.data.sender,
        subject: email.subject,
        body: email.body,
      });

      console.log(`[DEBUG] sendEmail RESULT ${email.id} = SUCCESS`);
      console.log(`[EMAIL] delivery successful ${email.id}`);
      console.log(`[DEBUG] ABOUT TO UPDATE DB TO SENT ${email.id}`);

      await prisma.scheduledEmail.update({
        where: { id: email.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          processingAt: null,
          error: null,
        },
      });
      console.log(`[EMAIL] status updated to SENT ${email.id}`);

      const afterUpdate = await prisma.scheduledEmail.findUnique({
        where: { id: email.id },
        select: { status: true },
      });
      console.log(`[DEBUG] DB STATUS AFTER UPDATE ${email.id} = ${afterUpdate?.status ?? 'MISSING'}`);
      console.log(`Email sent to ${email.recipientEmail}${preview ? `; Preview: ${preview}` : ''}`);
    } catch (error) {
      console.error(`[DEBUG] sendEmail RESULT ${job.data.scheduledEmailId} = ERROR: ${error instanceof Error ? error.message : String(error)}`);
      await prisma.scheduledEmail.update({
        where: { id: job.data.scheduledEmailId },
        data: {
          status: 'SCHEDULED',
          processingAt: null,
          error: error instanceof Error ? error.message : 'Unknown SMTP error',
        },
      });
      console.error(`[EMAIL] delivery failed ${job.data.scheduledEmailId}`);
      throw error;
    }
  }, { connection, concurrency: env.WORKER_CONCURRENCY, maxStalledCount: 1 });

  worker.on('ready', () => console.log(`Email worker ready on queue ${QUEUE_NAME} with concurrency ${env.WORKER_CONCURRENCY}`));
  worker.on('error', error => console.error(`BullMQ worker error (${QUEUE_NAME}): ${error.message}`));
  worker.on('failed', async (job, error) => {
    console.error(`Email job failed after retry attempt ${job?.attemptsMade ?? 0}: ${error.message}`);
    if (job && job.attemptsMade < 3) console.log(`[EMAIL] retry scheduled ${job.data.scheduledEmailId}`);
    if (job && job.attemptsMade >= 3) {
      await prisma.scheduledEmail.update({
        where: { id: job.data.scheduledEmailId },
        data: { status: 'FAILED', processingAt: null, error: error.message },
      });
      console.error(`[EMAIL] permanently failed ${job.data.scheduledEmailId}`);
    }
  });

  return worker;
}

import { Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import env from './config';
import { connection, EmailJob, enqueueEmail, QUEUE_NAME } from './queue';
import { sendEmail } from './mailer';

const prisma = new PrismaClient();
const senderLockScript = `local current = redis.call('GET', KEYS[1]); local now = tonumber(ARGV[1]); local delay = tonumber(ARGV[2]); if current and tonumber(current) > now then return tonumber(current) - now end; redis.call('SET', KEYS[1], now + delay, 'PX', delay + 5000); return 0`;
const hourCounterScript = `local current = tonumber(redis.call('GET', KEYS[1]) or '0'); local maximum = tonumber(ARGV[1]); if current >= maximum then return 0 end; local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], 3700) end; return count`;
const releaseHourSlotScript = `local current = redis.call('GET', KEYS[1]); if not current then return 0 end; local remaining = redis.call('DECR', KEYS[1]); if remaining <= 0 then redis.call('DEL', KEYS[1]); return 0 end; return remaining`;

type ThrottleResult = { wait: number; hourlyKey?: string };

async function claim(id: string) {
  const result = await prisma.scheduledEmail.updateMany({
    where: {
      id,
      scheduledAt: { lte: new Date() },
      status: { in: ['SCHEDULED', 'QUEUED'] },
    },
    data: { status: 'PROCESSING', processingAt: new Date(), attempts: { increment: 1 } },
  });
  return result.count === 1;
}
async function throttle(sender: string, hourlyLimit: number): Promise<ThrottleResult> {
  const window = Math.floor(Date.now() / 3_600_000);
  if (env.MIN_SEND_DELAY_MS > 0) {
    const spacingWait = Number(await connection.eval(senderLockScript, 1, `sender:${sender}:spacing`, Date.now(), env.MIN_SEND_DELAY_MS));
    if (spacingWait > 0) return { wait: spacingWait };
  }
  const hourlyKey = `sender:${sender}:hour:${window}`;
  const count = Number(await connection.eval(hourCounterScript, 1, hourlyKey, hourlyLimit));
  return count === 0
    ? { wait: (window + 1) * 3_600_000 + 1000 - Date.now() }
    : { wait: 0, hourlyKey };
}

async function releaseHourlyReservation(hourlyKey: string) {
  await connection.eval(releaseHourSlotScript, 1, hourlyKey);
}

let worker: Worker<EmailJob> | undefined;

export function startWorker() {
  if (worker) return worker;

  worker = new Worker<EmailJob>(QUEUE_NAME, async job => {
  if (!(await claim(job.data.scheduledEmailId))) {
    const existing = await prisma.scheduledEmail.findUnique({ where: { id: job.data.scheduledEmailId }, select: { status: true } });
    if (existing?.status === 'SENT') console.log(`Skipping already sent email ${job.data.scheduledEmailId}`);
    return;
  }
  console.log(`Email became eligible: ${job.data.scheduledEmailId}`);
  console.log(`Email processing: ${job.data.scheduledEmailId}`);
  let hourlyReservationKey: string | undefined;
  let deliverySucceeded = false;
  try {
    const email = await prisma.scheduledEmail.findUniqueOrThrow({ where: { id: job.data.scheduledEmailId }, include: { campaign: true } });
    const throttleResult = await throttle(job.data.sender, email.campaign.hourlyLimit);
    hourlyReservationKey = throttleResult.hourlyKey;
    if (throttleResult.wait > 0) {
      await prisma.scheduledEmail.update({ where: { id: email.id }, data: { status: 'QUEUED', processingAt: null } });
      const retryJob = await enqueueEmail(email.id, job.data.sender, new Date(Date.now() + throttleResult.wait), `:retry:${Date.now()}`);
      await prisma.scheduledEmail.update({ where: { id: email.id }, data: { bullJobId: retryJob.id } });
      console.log(`Email waiting because hourly limit or throttling was reached: ${email.id}`);
      return;
    }
    console.log(`Email sending: ${email.id}`);
    const preview = await sendEmail({ id: email.id, recipient: email.recipientEmail, sender: job.data.sender, subject: email.subject, body: email.body });
    deliverySucceeded = true;
    await prisma.scheduledEmail.update({ where: { id: email.id }, data: { status: 'SENT', sentAt: new Date(), processingAt: null, error: null } });
    console.log(`Email sent to ${email.recipientEmail}${preview ? `; Preview: ${preview}` : ''}`);
  } catch (error) {
    if (hourlyReservationKey && !deliverySucceeded) await releaseHourlyReservation(hourlyReservationKey);
    await prisma.scheduledEmail.update({ where: { id: job.data.scheduledEmailId }, data: { status: 'QUEUED', processingAt: null, error: error instanceof Error ? error.message : 'Unknown SMTP error' } });
    console.error(`Email failed and will retry: ${job.data.scheduledEmailId}`);
    throw error;
  }
  }, { connection, concurrency: env.WORKER_CONCURRENCY, maxStalledCount: 1 });
  worker.on('ready', () => console.log(`Email worker ready on queue ${QUEUE_NAME} with concurrency ${env.WORKER_CONCURRENCY}`));
  worker.on('error', error => console.error(`BullMQ worker error (${QUEUE_NAME}): ${error.message}`));
  worker.on('failed', async (job, error) => {
    console.error(`Email job failed after retry attempt ${job?.attemptsMade ?? 0}: ${error.message}`);
    if (job && job.attemptsMade >= 3) {
      await prisma.scheduledEmail.update({ where: { id: job.data.scheduledEmailId }, data: { status: 'FAILED', processingAt: null, error: error.message } });
      console.error(`Email failed permanently: ${job.data.scheduledEmailId}`);
    }
  });
  return worker;
}

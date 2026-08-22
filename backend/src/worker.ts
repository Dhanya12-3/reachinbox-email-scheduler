import { Worker } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import env from './config';
import { connection, EmailJob, enqueueEmail, QUEUE_NAME } from './queue';
import { sendEmail } from './mailer';

const prisma = new PrismaClient();
const throttleScript = `local count = tonumber(redis.call('GET', KEYS[1]) or '0'); local maximum = tonumber(ARGV[1]); local now = tonumber(ARGV[1 + 1]); local spacingUntil = tonumber(redis.call('GET', KEYS[2]) or '0'); if count >= maximum then return {0, count, 0} end; if spacingUntil > now then return {-1, count, spacingUntil - now} end; local nextCount = redis.call('INCR', KEYS[1]); if nextCount == 1 then redis.call('EXPIRE', KEYS[1], 3700) end; local delay = tonumber(ARGV[3]); if delay > 0 then redis.call('SET', KEYS[2], now + delay, 'PX', delay + 5000) end; return {1, nextCount, 0}`;
const releaseHourSlotScript = `local current = redis.call('GET', KEYS[1]); if not current then return 0 end; local remaining = redis.call('DECR', KEYS[1]); if remaining <= 0 then redis.call('DEL', KEYS[1]); return 0 end; return remaining`;

type ThrottleResult = { wait: number; hourlyKey?: string };

async function claim(id: string) {
  const result = await prisma.scheduledEmail.updateMany({
    where: {
      id,
      scheduledAt: { lte: new Date() },
      status: 'QUEUED',
    },
    data: { status: 'PROCESSING', processingAt: new Date(), attempts: { increment: 1 } },
  });
  return result.count === 1;
}
async function markEligible(id: string) {
  await prisma.scheduledEmail.updateMany({
    where: { id, scheduledAt: { lte: new Date() }, status: 'SCHEDULED' },
    data: { status: 'QUEUED' },
  });
}
async function throttle(sender: string, hourlyLimit: number): Promise<ThrottleResult> {
  const window = Math.floor(Date.now() / 3_600_000);
  const hourlyKey = `sender:v2:${sender}:hour:${window}`;
  const spacingKey = `sender:v2:${sender}:spacing`;
  const now = Date.now();
  const result = await connection.eval(throttleScript, 2, hourlyKey, spacingKey, hourlyLimit, now, env.MIN_SEND_DELAY_MS) as [number | string, number | string, number | string];
  const decision = Number(result[0]);
  const count = Number(result[1]);
  console.log(`[THROTTLE] sender=${sender} count=${count} limit=${hourlyLimit}`);
  if (decision === 0) {
    const wait = Math.max(1, (window + 1) * 3_600_000 + 1000 - now);
    console.log(`[THROTTLE] quota exhausted; next window in ${wait}ms`);
    return { wait };
  }
  if (decision < 0) {
    const wait = Math.max(1, Number(result[2]));
    console.log(`[THROTTLE] sender=${sender} spacing wait=${wait}ms`);
    return { wait };
  }
  console.log('[THROTTLE] quota available');
  return { wait: 0, hourlyKey };
}

async function releaseHourlyReservation(hourlyKey: string) {
  await connection.eval(releaseHourSlotScript, 1, hourlyKey);
}

let worker: Worker<EmailJob> | undefined;

export function startWorker() {
  if (worker) return worker;

  worker = new Worker<EmailJob>(QUEUE_NAME, async job => {
  console.log(`[DEBUG] JOB RECEIVED ${job.data.scheduledEmailId}`);
  const beforeClaim = await prisma.scheduledEmail.findUnique({ where: { id: job.data.scheduledEmailId }, select: { status: true } });
  console.log(`[DEBUG] CURRENT DB STATUS ${job.data.scheduledEmailId} = ${beforeClaim?.status ?? 'MISSING'}`);
  await markEligible(job.data.scheduledEmailId);
  if (!(await claim(job.data.scheduledEmailId))) {
    console.log(`[DEBUG] CLAIM RESULT ${job.data.scheduledEmailId} = false`);
    const existing = await prisma.scheduledEmail.findUnique({ where: { id: job.data.scheduledEmailId }, select: { status: true } });
    if (existing?.status === 'SENT') console.log(`Skipping already sent email ${job.data.scheduledEmailId}`);
    return;
  }
  console.log(`[DEBUG] CLAIM RESULT ${job.data.scheduledEmailId} = true`);
  console.log(`Email became eligible: ${job.data.scheduledEmailId}`);
  console.log(`Email processing: ${job.data.scheduledEmailId}`);
  let hourlyReservationKey: string | undefined;
  let deliverySucceeded = false;
  try {
    const email = await prisma.scheduledEmail.findUniqueOrThrow({ where: { id: job.data.scheduledEmailId }, include: { campaign: true } });
    const throttleResult = await throttle(job.data.sender, email.campaign.hourlyLimit);
    hourlyReservationKey = throttleResult.hourlyKey;
    console.log(`[DEBUG] THROTTLE RESULT ${email.id} = ${throttleResult.wait}`);
    if (throttleResult.wait > 0) {
      await prisma.scheduledEmail.update({ where: { id: email.id }, data: { status: 'QUEUED', processingAt: null } });
      const retryAt = new Date(Date.now() + throttleResult.wait);
      const retryJob = await enqueueEmail(email.id, job.data.sender, retryAt, `:retry:${Date.now()}`);
      await prisma.scheduledEmail.update({ where: { id: email.id }, data: { bullJobId: retryJob.id } });
      console.log(`Email waiting because hourly limit or throttling was reached: ${email.id}`);
      console.log(`[DEBUG] retry scheduled ${email.id} for ${retryAt.toISOString()}`);
      return;
    }
    console.log(`[DEBUG] ABOUT TO CALL sendEmail ${email.id}`);
    console.log(`[EMAIL] sending ${email.id}`);
    const preview = await sendEmail({ id: email.id, recipient: email.recipientEmail, sender: job.data.sender, subject: email.subject, body: email.body });
    deliverySucceeded = true;
    console.log(`[DEBUG] sendEmail RESULT ${email.id} = SUCCESS`);
    console.log(`[DEBUG] ABOUT TO UPDATE DB TO SENT ${email.id}`);
    await prisma.scheduledEmail.update({ where: { id: email.id }, data: { status: 'SENT', sentAt: new Date(), processingAt: null, error: null } });
    const afterUpdate = await prisma.scheduledEmail.findUnique({ where: { id: email.id }, select: { status: true } });
    console.log(`[DEBUG] DB STATUS AFTER UPDATE ${email.id} = ${afterUpdate?.status ?? 'MISSING'}`);
    console.log(`[EMAIL] sent successfully ${email.id}`);
    console.log(`Email sent to ${email.recipientEmail}${preview ? `; Preview: ${preview}` : ''}`);
  } catch (error) {
    if (hourlyReservationKey && !deliverySucceeded) await releaseHourlyReservation(hourlyReservationKey);
    console.error(`[DEBUG] sendEmail RESULT ${job.data.scheduledEmailId} = ERROR: ${error instanceof Error ? error.message : String(error)}`);
    await prisma.scheduledEmail.update({ where: { id: job.data.scheduledEmailId }, data: { status: 'QUEUED', processingAt: null, error: error instanceof Error ? error.message : 'Unknown SMTP error' } });
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
      await prisma.scheduledEmail.update({ where: { id: job.data.scheduledEmailId }, data: { status: 'FAILED', processingAt: null, error: error.message } });
      console.error(`[EMAIL] permanently failed ${job.data.scheduledEmailId}`);
    }
  });
  return worker;
}

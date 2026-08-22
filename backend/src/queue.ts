import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import env from './config';

export const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const emailQueue = new Queue('email-delivery', { connection });
export type EmailJob = { scheduledEmailId: string; sender: string };
export async function enqueueEmail(scheduledEmailId: string, sender: string, scheduledAt: Date, suffix = '') {
	return emailQueue.add(`deliver:${scheduledEmailId}`, { scheduledEmailId, sender }, { jobId: `${scheduledEmailId}${suffix}`, delay: Math.max(0, scheduledAt.getTime() - Date.now()), attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 1000 });
}

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import env from './config';

export const QUEUE_NAME = 'email-delivery';
const redisUrl = new URL(env.REDIS_URL);
function errorDetails(error: unknown) {
	if (!(error instanceof Error)) return String(error);
	const details = error as Error & { code?: string; address?: string; port?: number };
	return [details.message, details.code, details.address && details.port ? `${details.address}:${details.port}` : details.address].filter(Boolean).join(' | ');
}

export const connection = new IORedis(env.REDIS_URL, {
	maxRetriesPerRequest: null,
	connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
	tls: redisUrl.protocol === 'rediss:' ? {} : undefined,
	retryStrategy: attempts => Math.min(attempts * 500, 5000),
});
export const emailQueue = new Queue(QUEUE_NAME, { connection });
export type EmailJob = { scheduledEmailId: string };

connection.on('connect', () => console.log(`Redis connecting (${redisUrl.protocol}//${redisUrl.hostname}:${redisUrl.port || (redisUrl.protocol === 'rediss:' ? 6380 : 6379)})`));
connection.on('ready', () => console.log('Redis connection ready'));
connection.on('reconnecting', (delay: number) => console.warn(`Redis reconnecting in ${delay}ms`));
connection.on('error', error => console.error(`Redis connection error: ${errorDetails(error)}`));
emailQueue.on('error', error => console.error(`BullMQ queue error (${QUEUE_NAME}): ${errorDetails(error)}`));

export async function waitForQueue(timeoutMs = env.REDIS_CONNECT_TIMEOUT_MS) {
	await Promise.race([
		emailQueue.waitUntilReady(),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Redis was not ready within ${timeoutMs}ms.`)), timeoutMs)),
	]);
}

export async function enqueueEmail(scheduledEmailId: string, scheduledAt: Date, suffix = '') {
	await waitForQueue();
	return emailQueue.add(`demo:${scheduledEmailId}`, { scheduledEmailId }, { jobId: `${scheduledEmailId}${suffix}`, delay: Math.max(0, scheduledAt.getTime() - Date.now()), attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 });
}

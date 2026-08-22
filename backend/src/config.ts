import 'dotenv/config';
import { z } from 'zod';

const env = z.object({
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  ETHEREAL_USER: z.string().optional(), ETHEREAL_PASS: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(), GOOGLE_CLIENT_SECRET: z.string().optional(), GOOGLE_CALLBACK_URL: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  MAX_EMAILS_PER_HOUR: z.coerce.number().int().positive().default(200),
  MIN_SEND_DELAY_MS: z.coerce.number().int().nonnegative().default(2000)
}).parse(process.env);

try {
  const redisProtocol = new URL(env.REDIS_URL).protocol;
  if (!['redis:', 'rediss:'].includes(redisProtocol) || env.REDIS_URL.includes('redis-cli')) throw new Error();
} catch {
  throw new Error('REDIS_URL must be a redis:// or rediss:// connection URL.');
}

export const frontendOrigins = env.FRONTEND_URL.split(',').map(origin => origin.trim()).filter(Boolean);
export default env;

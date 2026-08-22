import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import env, { frontendOrigins } from './config';
import { enqueueEmail } from './queue';
import { startWorker } from './worker';

const prisma = new PrismaClient();
const app = express();
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || frontendOrigins.includes(origin)),
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

const sessionCookie = 'reachinbox_session';
const emailSchema = z.string().trim().email();
const scheduleSchema = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(300),
  body: z.string().min(1),
  recipients: z.array(emailSchema).min(1).max(10000),
  senderId: z.string().optional(),
  startTime: z.string().datetime(),
  delayMs: z.number().int().min(0).max(86_400_000).default(env.MIN_SEND_DELAY_MS),
  hourlyLimit: z.number().int().positive().max(10000).default(env.MAX_EMAILS_PER_HOUR),
});

function cookieValue(request: express.Request, name: string) {
  return request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function currentUser(request: express.Request) {
  const token = cookieValue(request, sessionCookie);
  if (!token) return undefined;

  const session = await prisma.authSession.findUnique({ where: { id: token }, include: { user: true } });
  return session && session.expiresAt > new Date() ? session.user : undefined;
}

async function requireUser(request: express.Request, response: express.Response) {
  const user = await currentUser(request);
  if (!user) {
    response.status(401).json({ error: 'Authentication required.' });
    return undefined;
  }

  return user;
}

async function createSession(userId: string) {
  const id = crypto.randomBytes(32).toString('hex');
  await prisma.authSession.create({ data: { id, userId, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
  return id;
}

function setSession(response: express.Response, token: string) {
  const sameSite = process.env.NODE_ENV === 'production' ? 'SameSite=None; Secure' : 'SameSite=Lax';
  response.setHeader('Set-Cookie', `${sessionCookie}=${token}; HttpOnly; ${sameSite}; Path=/; Max-Age=604800`);
}

async function enqueueWithTimeout(emailId: string, sender: string, scheduledAt: Date) {
  return Promise.race([
    enqueueEmail(emailId, sender, scheduledAt),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Queue insertion timed out after ${env.REDIS_CONNECT_TIMEOUT_MS}ms.`)), env.REDIS_CONNECT_TIMEOUT_MS + 1000);
    }),
  ]);
}

async function resolveSender(user: { id: string; email: string }, senderId?: string) {
  if (senderId) {
    return prisma.sender.findFirst({ where: { id: senderId, userId: user.id } });
  }

  const existing = await prisma.sender.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });

  return existing ?? prisma.sender.upsert({
    where: { userId_email: { userId: user.id, email: user.email.toLowerCase() } },
    update: {},
    create: {
      id: crypto.randomUUID(),
      email: user.email.toLowerCase(),
      userId: user.id,
    },
  });
}

app.get('/', (_req, res) => res.json({ name: 'ReachInbox Email Scheduler API', dashboard: env.FRONTEND_URL, health: '/api/health' }));
app.get('/health', (_req, res) => res.redirect('/api/health'));
app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.get('/auth/me', async (req, res) => {
  const user = await currentUser(req);
  res.json({ authenticated: Boolean(user), user: user ?? null });
});

app.post('/auth/logout', async (req, res) => {
  const token = cookieValue(req, sessionCookie);
  if (token) await prisma.authSession.deleteMany({ where: { id: token } });

  const sameSite = process.env.NODE_ENV === 'production' ? 'SameSite=None; Secure' : 'SameSite=Lax';
  res.setHeader('Set-Cookie', `${sessionCookie}=; HttpOnly; ${sameSite}; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.post('/auth/email', async (req, res) => {
  const parsed = z.object({ email: emailSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email address.' });

  const email = parsed.data.email.toLowerCase();
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { id: crypto.randomUUID(), email, name: email.split('@')[0], googleId: `email:${email}` },
  });

  setSession(res, await createSession(user.id));
  res.json({ user });
});

app.get('/auth/google', (_req, res) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_CALLBACK_URL) {
    return res.status(501).json({ error: 'Google OAuth is not configured correctly.' });
  }

  const state = crypto.randomBytes(24).toString('hex');
  const sameSite = process.env.NODE_ENV === 'production' ? 'SameSite=None; Secure' : 'SameSite=Lax';
  res.setHeader('Set-Cookie', `reachinbox_oauth_state=${state}; HttpOnly; ${sameSite}; Path=/; Max-Age=600`);

  const client = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CALLBACK_URL);
  res.redirect(client.generateAuthUrl({ access_type: 'offline', scope: ['openid', 'email', 'profile'], prompt: 'select_account', state }));
});

app.get('/auth/google/callback', async (req, res) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_CALLBACK_URL) {
    return res.status(501).send('Google OAuth is not configured.');
  }

  try {
    const stateCookie = cookieValue(req, 'reachinbox_oauth_state');
    res.append('Set-Cookie', 'reachinbox_oauth_state=; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=0');
    if (!req.query.code || String(req.query.state) !== stateCookie) return res.status(400).send('Invalid OAuth state.');

    const client = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CALLBACK_URL);
    const { tokens } = await client.getToken(String(req.query.code));
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token!, audience: env.GOOGLE_CLIENT_ID });
    const profile = ticket.getPayload();
    if (!profile?.sub || !profile.email) return res.status(400).send('Google profile is missing required fields.');

    const user = await prisma.user.findUnique({ where: { googleId: profile.sub } }) ?? await prisma.user.findUnique({ where: { email: profile.email } });
    const saved = user ? await prisma.user.update({
      where: { id: user.id },
      data: { googleId: profile.sub, name: profile.name ?? profile.email, email: profile.email, avatar: profile.picture },
    }) : await prisma.user.create({
      data: { id: crypto.randomUUID(), googleId: profile.sub, name: profile.name ?? profile.email, email: profile.email, avatar: profile.picture },
    });

    setSession(res, await createSession(saved.id));
    res.redirect(env.FRONTEND_URL);
  } catch {
    res.status(400).send('Google authentication failed.');
  }
});

app.get('/api/senders', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const senders = await prisma.sender.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
  });

  res.json({ senders });
});

app.post('/api/senders', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const parsed = z.object({
    email: emailSchema,
    name: z.string().trim().max(100).optional(),
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'A valid sender email is required.' });
  }

  const email = parsed.data.email.toLowerCase();
  const existing = await prisma.sender.findUnique({
    where: { userId_email: { userId: user.id, email } },
  });

  if (existing) {
    return res.status(409).json({ error: 'This sender already exists for your account.', sender: existing });
  }

  const sender = await prisma.sender.create({
    data: {
      id: crypto.randomUUID(),
      email,
      name: parsed.data.name?.trim() || null,
      userId: user.id,
    },
  });

  res.status(201).json({ sender });
});

app.get('/api/campaigns', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  res.json({
    campaigns: await prisma.campaign.findMany({
      where: { userId: user.id },
      include: { sender: true, _count: { select: { scheduledEmails: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  });
});

app.get('/api/emails', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const emails = await prisma.scheduledEmail.findMany({
    where: { campaign: { userId: user.id } },
    include: { campaign: { select: { name: true } } },
    orderBy: { scheduledAt: 'asc' },
    take: 1000,
  });

  const sentIds = emails.filter(email => email.status === 'SENT').map(email => email.id);
  console.log(`[DEBUG] API SENT QUERY RESULT ids=${sentIds.join(',') || 'none'}`);

  res.json({ emails });
});

app.get('/api/emails/sent', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const emails = await prisma.scheduledEmail.findMany({
    where: { campaign: { userId: user.id }, status: 'SENT' },
    include: { campaign: { select: { name: true } } },
    orderBy: { sentAt: 'desc' },
    take: 1000,
  });

  console.log(`[DEBUG] API SENT QUERY RESULT ids=${emails.map(email => email.id).join(',') || 'none'}`);
  res.json({ emails });
});

app.post('/api/emails/schedule', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const parsed = z.object({
    recipientEmail: emailSchema,
    subject: z.string().min(1).max(300),
    body: z.string().min(1),
    scheduledAt: z.string().datetime(),
    senderId: z.string().optional(),
  }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'recipientEmail, subject, body, and scheduledAt are required.' });
  }

  const data = parsed.data;
  const scheduledAt = new Date(data.scheduledAt);
  if (scheduledAt.getTime() < Date.now() - 60_000) {
    return res.status(400).json({ error: 'scheduledAt must be in the future.' });
  }

  const sender = await resolveSender(user, data.senderId);

  if (!sender) {
    return res.status(400).json({ error: 'Create or select a sender before scheduling an email.' });
  }

  const email = await prisma.$transaction(async tx => {
    const campaign = await tx.campaign.create({
      data: { id: crypto.randomUUID(), name: data.subject, description: data.body, userId: user.id, senderId: sender.id, delayMs: env.MIN_SEND_DELAY_MS, hourlyLimit: env.MAX_EMAILS_PER_HOUR },
    });

    return tx.scheduledEmail.create({
      data: {
        id: crypto.randomUUID(),
        campaignId: campaign.id,
        recipientEmail: data.recipientEmail.toLowerCase(),
        subject: data.subject,
        body: data.body,
        scheduledAt,
        status: 'SCHEDULED',
      },
    });
  });

  try {
    const job = await enqueueEmail(email.id, sender.email, scheduledAt);
    const saved = await prisma.scheduledEmail.update({ where: { id: email.id }, data: { bullJobId: job.id } });
    return res.status(201).json({ email: saved, jobId: job.id });
  } catch (error) {
    await prisma.scheduledEmail.update({
      where: { id: email.id },
      data: { status: 'PENDING', error: error instanceof Error ? error.message : 'Queue unavailable' },
    });
    return res.status(503).json({ error: 'Email was stored but could not be queued. Retry after Redis is available.', emailId: email.id });
  }
});

app.post('/api/campaigns', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid campaign.' });
  }

  const data = parsed.data;
  const start = new Date(data.startTime);
  if (start.getTime() < Date.now() - 60_000) {
    return res.status(400).json({ error: 'Start time must be in the future.' });
  }

  const recipients = [...new Set(data.recipients.map(email => email.toLowerCase()))];
  const sender = await resolveSender(user, data.senderId);
  if (!sender) return res.status(400).json({ error: 'Create a sender before scheduling.' });

  const campaign = await prisma.$transaction(async tx => {
    const record = await tx.campaign.create({
      data: {
        id: crypto.randomUUID(),
        name: data.name,
        description: data.body,
        userId: user.id,
        senderId: sender.id,
        delayMs: data.delayMs,
        hourlyLimit: data.hourlyLimit,
      },
    });

    const emails = await Promise.all(recipients.map((recipient, index) =>
      tx.scheduledEmail.create({
        data: {
          id: crypto.randomUUID(),
          campaignId: record.id,
          recipientEmail: recipient,
          subject: data.subject,
          body: data.body,
          scheduledAt: new Date(start.getTime() + index * data.delayMs),
          status: 'SCHEDULED',
        },
      })
    ));

    return { record, emails };
  });

  try {
    await Promise.all(campaign.emails.map(async email => {
      const job = await enqueueWithTimeout(email.id, sender.email, email.scheduledAt);
      await prisma.scheduledEmail.update({ where: { id: email.id }, data: { bullJobId: job.id } });
      console.log(`Email scheduled: ${email.id} for ${email.scheduledAt.toISOString()}`);
    }));
  } catch (error) {
    console.error('Queue insertion failed; restart reconciliation will retry queued emails.', error instanceof Error ? error.message : 'unknown error');
  }

  res.status(201).json({ campaign: campaign.record, count: campaign.emails.length });
});

async function reconcileMissingJobs() {
  const stale = await prisma.scheduledEmail.updateMany({
    where: { status: 'PROCESSING', processingAt: { lt: new Date(Date.now() - 15 * 60_000) } },
    data: { status: 'QUEUED', processingAt: null },
  });

  const now = new Date();
  await prisma.scheduledEmail.updateMany({
    where: { status: { in: ['QUEUED', 'PENDING'] }, scheduledAt: { gt: now } },
    data: { status: 'SCHEDULED' },
  });

  const missing = await prisma.scheduledEmail.findMany({
    where: { status: { in: ['SCHEDULED', 'QUEUED', 'PENDING'] }, bullJobId: null },
    include: { campaign: { include: { sender: true } } },
  });

  let reconciled = 0;
  for (const email of missing) {
    const job = await enqueueEmail(email.id, email.campaign.sender.email, email.scheduledAt);
    const due = email.scheduledAt <= now;
    await prisma.scheduledEmail.update({
      where: { id: email.id },
      data: { status: due ? 'QUEUED' : 'SCHEDULED', bullJobId: job.id },
    });
    if (due) console.log(`Email became eligible during reconciliation: ${email.id}`);
    reconciled += 1;
  }

  if (reconciled || stale.count) {
    console.log(`Reconciled ${reconciled} missing jobs and ${stale.count} stale claims`);
  }
}

app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
  startWorker();
  console.log('Email worker initialization requested in API process');
  void reconcileMissingJobs().catch((error: unknown) => console.error('Queue reconciliation unavailable:', error instanceof Error ? error.message : 'unknown error'));
});

# ReachInbox Email Scheduler

A production-minded email scheduling slice built with Express, BullMQ, Redis, PostgreSQL, Prisma, React, and Ethereal SMTP.

## Run locally

1. Install Node 20+, Docker, and npm.
2. Run `docker compose up -d`.
3. Copy `backend/.env.example` to `backend/.env` and add the Ethereal and Google credentials. The Google callback must be exactly `http://localhost:4000/auth/google/callback`.
4. Copy `frontend/.env.example` to `frontend/.env` and keep `VITE_API_URL=http://localhost:4000` for local development.
5. Run `npm install`, `npm --prefix backend install`, and `npm --prefix frontend install`.
6. Run `npm run db:generate`, `npm run db:migrate`, then start the API and worker in separate terminals: `npm --prefix backend run dev` and `npm --prefix backend run worker`. Start the frontend with `npm --prefix frontend run dev`.
7. Open `http://localhost:5173`.

## Architecture

The API authenticates a user, validates sender ownership, creates Campaign and ScheduledEmail rows in PostgreSQL, then enqueues deterministic BullMQ delayed jobs. The worker atomically claims due `SCHEDULED` rows, sends through the configured mail provider, and records `SENT` with `sentAt` only after successful delivery. Delivery failures are retried three times and then recorded as `FAILED`. Redis AOF and a volume preserve delayed jobs across container restarts.

`db:migrate` runs `prisma migrate deploy`, including the additive production schema migration. It never resets or deletes production data.

## Render deployment

Use these commands for the backend web service:

- Build: `npm install && npm run db:generate && npm run db:migrate && npm run build`
- Start: `npm run start`

Create a separate background worker service from the same repository:

- Build: `npm install && npm run db:generate && npm run build`
- Start: `npm run start:worker`

Backend variables: `DATABASE_URL`, `REDIS_URL`, `FRONTEND_URL`, `NODE_ENV`, `MAIL_PROVIDER`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL`. For production HTTPS delivery, set `MAIL_PROVIDER=resend`, `RESEND_API_KEY`, and a verified `RESEND_FROM` address. For local Ethereal SMTP, set `MAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `ETHEREAL_USER`, and `ETHEREAL_PASS`. Set `FRONTEND_URL` to the deployed frontend origin; comma-separated origins are supported for local plus production access.

Frontend variable: `VITE_API_URL`, set to the deployed backend URL, with no trailing slash.

Register `GOOGLE_CALLBACK_URL` exactly in Google Cloud Console. For production this is `https://<backend-service>.onrender.com/auth/google/callback`; keep the localhost callback as a separate development OAuth redirect URI.

BullMQ handles the scheduled delivery time and retry backoff. There is no queued or hourly-limit delivery state; emails remain `SCHEDULED` until the worker successfully sends them or permanently records `FAILED`.

For Resend testing, use `MAIL_PROVIDER=resend`, `RESEND_FROM=onboarding@resend.dev`, and test with `dhanyaharikant777@gmail.com`. Resend accounts in testing mode can send only to the account owner's email address; example.com and example.org recipients will be rejected until the account is approved for production sending.

## Features

- Create campaigns with a sender, subject/body, CSV/TXT recipient list, start time, and delay.
- Scheduled and sent views with loading, empty, and error states.
- Persisted HTTP-only email and Google OAuth sessions with logout and protected API routes.
- Configurable worker concurrency and scheduled delivery delay.
- Dockerized PostgreSQL and Redis.

## Assumptions and trade-offs

The default local sender is one Ethereal account; multiple sender addresses can be submitted through the API, but all local Ethereal sends use the same configured SMTP account. Configured Google credentials enable the real OAuth flow. Ethereal previews are logged by the worker because they do not deliver to real inboxes.

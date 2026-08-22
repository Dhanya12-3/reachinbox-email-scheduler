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

The API authenticates a user, validates sender ownership, creates Campaign and ScheduledEmail rows in PostgreSQL, then enqueues deterministic BullMQ delayed jobs. The worker claims `QUEUED` rows atomically, sends through configured Ethereal SMTP, and records `SENT` plus the Ethereal preview URL or `FAILED` after three BullMQ attempts. Redis AOF and a volume preserve delayed jobs across container restarts.

`db:migrate` runs `prisma migrate deploy`, including the additive production schema migration. It never resets or deletes production data.

## Render deployment

Use these commands for the backend web service:

- Build: `npm install && npm run db:generate && npm run db:migrate && npm run build`
- Start: `npm run start`

Create a separate background worker service from the same repository:

- Build: `npm install && npm run db:generate && npm run build`
- Start: `npm run start:worker`

Backend variables: `DATABASE_URL`, `REDIS_URL`, `FRONTEND_URL`, `NODE_ENV=production`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `ETHEREAL_USER`, and `ETHEREAL_PASS`. Set `FRONTEND_URL` to the deployed frontend origin; comma-separated origins are supported for local plus production access.

Frontend variable: `VITE_API_URL`, set to the deployed backend URL, with no trailing slash.

Register `GOOGLE_CALLBACK_URL` exactly in Google Cloud Console. For production this is `https://<backend-service>.onrender.com/auth/google/callback`; keep the localhost callback as a separate development OAuth redirect URI.

Worker concurrency and throttling are configurable. Each sender uses a Redis Lua-backed fixed-hour counter (`sender:<id>:hour:<window>`), with an atomic increment and expiry. If the limit is exhausted, the job is moved to the next hour window rather than failed. `MIN_SEND_DELAY_MS` is enforced with a Redis-backed sender lock, so multiple workers share the delay. For a 1000-recipient burst, BullMQ holds jobs durably and the sender/hour limits spread them across future windows.

## Features

- Create campaigns with a sender, subject/body, CSV/TXT recipient list, start time, delay, and hourly limit.
- Scheduled and sent views with loading, empty, and error states.
- Persisted HTTP-only email and Google OAuth sessions with logout and protected API routes.
- Configurable worker concurrency, per-sender hourly limit, and inter-send delay.
- Dockerized PostgreSQL and Redis.

## Assumptions and trade-offs

The default local sender is one Ethereal account; multiple sender addresses can be submitted through the API, but all local Ethereal sends use the same configured SMTP account. Configured Google credentials enable the real OAuth flow. Ethereal previews are logged by the worker because they do not deliver to real inboxes.

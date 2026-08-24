# ReachInbox Email Scheduler

A demo email scheduling application built with Express, BullMQ, Redis, PostgreSQL, Prisma, and React.

## Run locally

1. Install Node 20+, Docker, and npm.
2. Run `docker compose up -d`.
3. Copy `backend/.env.example` to `backend/.env` and add the Google credentials if needed. The Google callback must be exactly `http://localhost:4000/auth/google/callback`.
4. Copy `frontend/.env.example` to `frontend/.env` and keep `VITE_API_URL=http://localhost:4000` for local development.
5. Run `npm install`, `npm --prefix backend install`, and `npm --prefix frontend install`.
6. Run `npm run db:generate`, `npm run db:migrate`, then start the API and worker in separate terminals: `npm --prefix backend run dev` and `npm --prefix backend run worker`. Start the frontend with `npm --prefix frontend run dev`.
7. Open `http://localhost:5173`.

## Architecture

The API authenticates a user, validates sender ownership, creates Campaign and ScheduledEmail rows in PostgreSQL, then enqueues deterministic BullMQ delayed jobs. The worker fetches due `SCHEDULED` rows and atomically records demo delivery as `SENT` with `sentAt`. No email provider is contacted. Redis AOF and a volume preserve delayed jobs across container restarts.

`db:migrate` runs `prisma migrate deploy`, including the additive production schema migration. It never resets or deletes production data.

If Render reports `P3009` or says that migrations exist in the database but not locally, stop the deploy and reconcile the migration history before retrying. Compare the database's `_prisma_migrations` rows with this repository, then use `prisma migrate resolve --applied <migration-name>` only for migrations already verified as applied. Do not run `prisma migrate reset` against the production database.

## Render deployment

Use these commands for the backend web service:

- Build: `npm install && npm run db:generate && npm run db:migrate && npm run build`
- Start: `npm run start`

Create a separate background worker service from the same repository:

- Build: `npm install && npm run db:generate && npm run build`
- Start: `npm run start:worker`

Backend variables: `DATABASE_URL`, `REDIS_URL`, `FRONTEND_URL`, `NODE_ENV`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL`. Set `FRONTEND_URL` to the deployed frontend origin; comma-separated origins are supported for local plus production access.

Frontend variable: `VITE_API_URL`, set to the deployed backend URL, with no trailing slash.

Register `GOOGLE_CALLBACK_URL` exactly in Google Cloud Console. For production this is `https://<backend-service>.onrender.com/auth/google/callback`; keep the localhost callback as a separate development OAuth redirect URI.

BullMQ handles the scheduled delivery time. There are only two email states: `SCHEDULED` and `SENT`. The worker simulates delivery locally, so dummy recipients such as `noah.thomas@example.org` never receive anything and no API key or email provider is required.

## Features

- Create campaigns with a sender, subject/body, CSV/TXT recipient list, start time, and delay.
- Scheduled and sent views with loading, empty, and error states.
- Persisted HTTP-only email and Google OAuth sessions with logout and protected API routes.
- Configurable worker concurrency and scheduled delivery delay.
- Dockerized PostgreSQL and Redis.

## Assumptions and trade-offs

Configured Google credentials enable the optional OAuth flow. Sender records are retained as campaign metadata; they are never used to send mail in demo mode.

# Kaimana — Backend

The API behind [Kaimana](https://kaimana.vercel.app), a competitive-programming platform: problems judged against hidden tests, an AI coach, mock interviews, contests, a community feed and a kids' coding track.

The web app lives in [Kaimana](https://github.com/tumit-h-r-75/Kaimana).

- **API:** https://kaimana-back.vercel.app
- **Health check:** `GET /api/health` (does not touch the database, so a cold or unreachable MongoDB can be told apart from a dead function)

---

## Tech stack

- **Node.js 22+**, **Express 5**, **TypeScript**
- **MongoDB** with **Mongoose 8**
- **Zod** for environment validation
- **Judge0** for running code in Python, C++, JavaScript and TypeScript
- **Groq**, with **Gemini** as fallback, for hints, complexity audits, refactors, interviews and test generation
- **Cloudinary** for profile photos, **Google Identity** for sign-in
- Deployed on **Vercel** as a serverless function (`api/index.ts`)

## Getting started

```bash
npm install
# create .env.local with the variables below
npm run dev        # tsx watch, http://localhost:5000
```

| Script | Does |
| --- | --- |
| `npm run dev` | Development server with reload |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Type-check everything, scripts included |
| `npm run seed` | Load the starter problem set and test cases |

Other scripts, run with `npx tsx src/scripts/<name>.ts`:

| Script | Does |
| --- | --- |
| `seed-demo` | Demo learners, a history of submissions, and contests in all three states |
| `seed-owner` | A solve history for the owner accounts (idempotent) |
| `verify-solutions` | Runs every reference solution against its problem's real tests |
| `seed-solutions` | Stores the reference solutions — only after `verify-solutions` passes |

## Environment variables

Validated at start-up in `src/config/env.ts`. **Never commit `.env.local`.**

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | yes | MongoDB connection string |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | yes | Token signing secrets |
| `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | yes | Token lifetimes, e.g. `15m`, `7d` |
| `FRONTEND_URL` | yes in production | Allowed CORS origins, comma-separated; defaults to localhost:3000 |
| `NODE_ENV`, `PORT` | no | Defaults `development`, `5000` |
| `JUDGE0_URL` | no | Judge0 endpoint; defaults to a shared public instance |
| `GROQ_API_KEY`, `GROQ_MODEL` | for AI | Primary model for every AI feature |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | for AI | Fallback when Groq is unavailable |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google sign-in | Google sign-in is hidden until set |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | for photo uploads | Profile pictures |
| `FEATURE_EXECUTION_VISUALIZER` | no | `true` enables the traced-run endpoint |

## API

Everything is under `/api`. Responses share one envelope: `{ success, statusCode, message, data }`.

| Area | Routes |
| --- | --- |
| Auth | `/auth` — email and Google sign-in, refresh, `me`, profile, password |
| Problems | `/problems` — list with search, difficulty, topic, acceptance rate and counts; `/topics`; `/recommended`; `/:slug` with stats and related problems; admin CRUD and test cases |
| Submissions | `/submissions` — submit, run on samples or custom stdin, traced runs, history with verdict filter, search and counts |
| AI | `/ai` — tiered hints, complexity audit, refactor suggestions, test generation |
| Contests | `/contests` — list, register, scoreboard, manager for admins and hosts |
| Interviews | `/interview` — sessions, follow-ups, rubric scoring |
| Community | `/community` — feed with search, difficulty, language and sort; solutions; comments |
| Notifications | `/notifications` — the latest for the signed-in user and the unread count; `POST /seen` |
| Host requests, proposals | `/host-requests`, `/proposals` — apply, review, refund rules |
| Leaderboard, analytics, kids, admin | `/leaderboard`, `/analytics`, `/kids`, `/admin` |

## Design notes

- **Live sessions.** `requireAuth` re-reads the user on every request, so a block or a role change takes effect at once rather than when a token expires. A password change bumps `tokenVersion` and revokes every earlier token.
- **Judging.** AI-generated test cases start unreviewed and grade nothing until an admin approves them.
- **Contests.** Accepted code stays out of the community feed while its contest is running.
- **Notifications.** Stored per event and addressed to one user, every admin, or everyone. A broadcast is stored once, and what a user has seen is a single timestamp on their account. Writing a notification never fails the action that caused it.
- **Search.** Search text is escaped and capped before it reaches `$regex`.
- **Serverless.** Socket.IO works when running the server locally but not on Vercel, so the web app polls for notifications.

## Project structure

```
api/            Vercel entry point
src/
  config/       Environment validation
  integrations/ Judge0, Google, Cloudinary
  middleware/   Auth, optional auth, admin checks
  models/       Mongoose schemas
  modules/      One folder per area: route → controller → service
  scripts/      Seeding and verification
  sockets/      Socket.IO (local server only)
  utils/        Errors, responses, JWT, scoring, gems, search helpers
```

## Author

Designed and built by **Tumit Hasan**.

[Portfolio](https://my-protfolio-tumit.web.app/) · [GitHub](https://github.com/tumit-h-r-75) · [LinkedIn](https://www.linkedin.com/in/tumit-hasan-rafi/)

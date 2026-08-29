# Kaimana Backend

Backend repository for the Kaimana platform.

## Technology Stack

- Node.js
- Express.js
- TypeScript
- MongoDB
- Mongoose
- Socket.IO

## Setup

```bash
npm install
npm run dev
npm run build
npm start
```

## Environment Variables

- `NODE_ENV`
- `PORT`
- `MONGODB_URI`
- `FRONTEND_URL`
- `GOOGLE_CLIENT_ID` (optional — Google sign-in is hidden on the frontend until this is set)
- `GOOGLE_CLIENT_SECRET`
- `JWT_ACCESS_SECRET` (required)
- `JWT_REFRESH_SECRET` (required)
- `JWT_ACCESS_EXPIRES_IN` (required, e.g. `15m`)
- `JWT_REFRESH_EXPIRES_IN` (required, e.g. `7d`)
- `JUDGE0_URL` (optional — defaults to Judge0's free public demo, `https://ce.judge0.com`)
- `ANTHROPIC_API_KEY` (optional — AI hints/interview features fall back to a deterministic response without it)
- `CLOUDINARY_CLOUD_NAME` (optional — avatar upload is skipped without it)
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

## Folder Structure

- `src/config/` — future configuration
- `src/controllers/` — future request handling
- `src/routes/` — future Express routes
- `src/models/` — future Mongoose models
- `src/services/` — future business services
- `src/middleware/` — future middleware
- `src/utils/` — future shared utilities
- `src/sockets/` — future Socket.IO structure

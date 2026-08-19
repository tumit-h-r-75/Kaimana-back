// Environment variable loading, validation, and app-wide configuration constants.

import dotenv from "dotenv"
import path from "path"

dotenv.config({ path: path.join(process.cwd(), ".env") });

export const config = {
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    mongodbUri: process.env.MONGODB_URI,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    jwtSecret: process.env.JWT_SECRET,
    frontendUrl: process.env.FRONTEND_URL,
    pistonUrl: process.env.PISTON_URL,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    socketPort: process.env.SOCKET_PORT,
}
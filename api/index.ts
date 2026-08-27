import app from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";

let databaseConnection: Promise<unknown> | undefined;

const ensureDatabaseConnection = () => {
  databaseConnection ??= connectDatabase();
  return databaseConnection;
};

export default async function handler(req: any, res: any) {
  // Keep the deployment health endpoint independent from MongoDB. This lets
  // Vercel (and humans) distinguish an unreachable function from a database
  // configuration problem.
  const requestPath = req.url?.split("?")[0];
  // Public endpoints must remain available even while MongoDB is cold,
  // unreachable, or still reconnecting.
  if (requestPath === "/api/health" || requestPath === "/health" || requestPath === "/api/auth/google/client-config") {
    return app(req, res);
  }

  try {
    await ensureDatabaseConnection();
    return app(req, res);
  } catch (error) {
    // Do not cache a failed initial connection for the lifetime of this
    // serverless instance; a later request can recover after Atlas/network
    // configuration is corrected.
    databaseConnection = undefined;
    console.error("Database connection failed:", error);
    return res.status(503).json({
      success: false,
      message: "Service temporarily unavailable.",
    });
  }
}

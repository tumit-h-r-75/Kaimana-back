import app from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";

let databaseConnection: Promise<unknown> | undefined;

const ensureDatabaseConnection = () => {
  databaseConnection ??= connectDatabase();
  return databaseConnection;
};

export default async function handler(req: any, res: any) {
  try {
    await ensureDatabaseConnection();
    return app(req, res);
  } catch (error) {
    console.error("Database connection failed:", error);
    return res.status(503).json({
      success: false,
      message: "Service temporarily unavailable.",
    });
  }
}

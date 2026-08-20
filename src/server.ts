// HTTP server initialization, Socket.IO setup, and main application entry point.

import http from "http";
import app from "./app.js";
import { config } from "./config/env.js";
import { connectDatabase } from "./config/database.js";

const PORT = config.port;

// Create HTTP server
const server = http.createServer(app);

// Start server
const startServer = async () => {
    try {
        await connectDatabase();
        server.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
    } catch (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
    }
};

startServer();
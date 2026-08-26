// HTTP server initialization, Socket.IO setup, and main application entry point.

import http from "http";
import app from "./app.js";
import { config } from "./config/env.js";
import { connectDatabase } from "./config/database.js";

const PORT = config.port;

// Create HTTP server
const server = http.createServer(app);

const reconnectDatabase = async () => {
    try {
        await connectDatabase();
    } catch (error) {
        console.error("MongoDB connection failed; retrying in 10 seconds:", error);
        setTimeout(reconnectDatabase, 10_000);
    }
};

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    void reconnectDatabase();
});

// HTTP server initialization, Socket.IO setup, and main application entry point.

import app from "./app.js";
import { config } from "./config/env.js";

const PORT = config.port

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
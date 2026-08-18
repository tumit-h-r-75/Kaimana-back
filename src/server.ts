// HTTP server initialization, Socket.IO setup, and main application entry point.
import express from "express";

const app = express();
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
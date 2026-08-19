// Express application configuration, middleware setup, and route mounting.

import express from "express"

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Kaimana Backend is running",
    })
})

export default app;
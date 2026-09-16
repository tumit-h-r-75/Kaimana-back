// Socket.IO server initialization and real-time event listener registration.

import type { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { config } from "../config/env.js";
import { jwtUtils } from "../utils/jwt.js";
import { registerSocketHandlers } from "./handlers.js";

// Singleton Socket.IO instance placeholder
let io: Server | null = null;

// Socket.IO middleware that runs on EVERY new client connection handshake
const authMiddleware = (socket: Socket, next: (err?: Error) => void) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace("Bearer ", "");

    if (!token) {
      return next(new Error("Authentication error: Token required"));
    }

    const verified = jwtUtils.verifyToken(token, config.jwtAccessSecret);
    if (!verified.success || !verified.data) {
      return next(new Error("Authentication error: Invalid or expired token"));
    }

    socket.data.user = verified.data;
    next();
  } catch (err) {
    next(new Error("Authentication error: Internal validation failure"));
  }
};

export const initSocketServer = (httpServer: HttpServer): Server => {
  io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigin || "*",
      credentials: true,
    },
  });

  io.use(authMiddleware);
  registerSocketHandlers(io);

  console.log("⚡ Socket.IO server initialized with JWT auth");
  return io;
};

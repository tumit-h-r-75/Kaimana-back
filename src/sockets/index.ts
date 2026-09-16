// Socket.IO server initialization and real-time event listener registration.

import type { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { config } from "../config/env.js";
import { jwtUtils } from "../utils/jwt.js";
import { registerSocketHandlers } from "./handlers.js";

// Singleton Socket.IO instance placeholder
let io: Server | null = null;

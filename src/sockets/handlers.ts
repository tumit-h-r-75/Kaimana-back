// Event handler functions for Socket.IO events delegating to module services.

import type { Server, Socket } from "socket.io";

export const getContestRoom = (contestId: string) => `contest:${contestId}`;
export const GLOBAL_LEADERBOARD_ROOM = "leaderboard:global";

export const registerSocketHandlers = (io: Server) => {
  io.on("connection", (socket: Socket) => {
    const user = socket.data.user;
    console.log(`🔌 Socket connected: ${socket.id} (User: ${user?.name ?? user?._id ?? "Unknown"})`);

    socket.on("disconnect", (reason) => {
      console.log(`🔌 Socket disconnected: ${socket.id} (Reason: ${reason})`);
    });
  });
};

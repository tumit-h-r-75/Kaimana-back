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

    // Join Contest Scoreboard Room
    socket.on("join:contest", (payload: { contestId?: string }) => {
      const contestId = payload?.contestId;
      if (typeof contestId !== "string" || !contestId.trim()) {
        socket.emit("error", { message: "contestId is required to join contest room." });
        return;
      }

      const room = getContestRoom(contestId.trim());
      socket.join(room);
      console.log(`🎯 Socket ${socket.id} joined room: ${room}`);
      socket.emit("joined:contest", { contestId, room });
    });

    // Leave Contest Scoreboard Room
    socket.on("leave:contest", (payload: { contestId?: string }) => {
      const contestId = payload?.contestId;
      if (typeof contestId === "string" && contestId.trim()) {
        const room = getContestRoom(contestId.trim());
        socket.leave(room);
        console.log(`🚪 Socket ${socket.id} left room: ${room}`);
      }
    });
  });
};

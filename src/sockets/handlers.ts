// Event handler functions for Socket.IO events delegating to module services.

import type { Server, Socket } from "socket.io";

export const getContestRoom = (contestId: string) => `contest:${contestId}`;
export const GLOBAL_LEADERBOARD_ROOM = "leaderboard:global";

export const registerSocketHandlers = (io: Server) => {
  // Handlers to be attached below
};

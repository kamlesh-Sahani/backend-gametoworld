import socketIo, { Server } from "socket.io";
import { Server as httpServer } from "http";
let io: Server | null = null;
const socketInit = async (server: httpServer) => {
  try {
    io = new Server(server, {
      cors: {
        origin:process.env.FRONTEND_URL || "http://localhost:3000",
        methods: ["POST", "GET"],
      },
    });

    io.on("connection", (socket) => {
      console.log("New client connected:", socket.id);
      socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
      });
    });

    return io;
  } catch (error: any) {
    console.log("socket init error:", error);
    throw error;
  }
};

export const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized");
  }
  return io;
};

export default socketInit;

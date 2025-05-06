import express from "express";
import http from "http";
import socketInit from "./utils/socket.util.js";
import { config } from "dotenv";
import { initThe08Paradox } from "./events/the08paradox.event.js";
import cors from "cors"
import { initUnoGame } from "./events/uno-card-online.js";
config();
// env variables 
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000"
const PORT = process.env.PORT || 5000


const app = express();
const server = http.createServer(app);

app.use(express.json());

cors({
    origin:FRONTEND_URL
})
socketInit(server);
// Initialize game sockets
initThe08Paradox();
initUnoGame();
app.get("/",(req,res)=>{
     res.json({
        message:"welcome to gametoworld server1"
    })
})
server.listen(PORT,()=>{
    console.log(`server is running on: http://locahost:${PORT}`);
})

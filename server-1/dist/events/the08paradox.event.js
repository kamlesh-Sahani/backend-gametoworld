import { getIO } from "../utils/socket.util.js";
export const initThe08Paradox = () => {
    const io = getIO();
    const activeGames = new Map();
    const ROUND_DURATION = 59; // seconds
    let MAX_ROUNDS = 5;
    const WIN_SCORE = 3;
    const LOSE_SCORE = -3;
    const startCountdown = (gameId) => {
        const game = activeGames.get(gameId);
        if (!game)
            return;
        game.countdown = ROUND_DURATION;
        game.status = "counting";
        // Update all players every second
        game.timer = setInterval(() => {
            game.countdown--;
            io.to(gameId).emit("countdownUpdate", game.countdown);
            if (game.countdown <= 0) {
                clearInterval(game.timer);
                evaluateRound(gameId);
            }
        }, 1000);
    };
    const evaluateRound = (gameId) => {
        const game = activeGames.get(gameId);
        if (!game)
            return;
        game.status = "finished";
        // Set null for players who didn't submit in time
        Object.values(game.players).forEach((player) => {
            if (player.number === null) {
                player.number = 0; // Consider 0 as automatic choice if not submitted
            }
        });
        // Calculate results
        const numbers = Object.values(game.players)
            .filter((p) => !p.isEliminated)
            .map((p) => p.number);
        if (numbers.length === 0)
            return;
        const average = numbers.reduce((a, b) => a + b, 0) / numbers.length;
        const target = average * 0.8;
        // Find the winner (closest number ≤ target)
        let winner = null;
        let minDiff = Infinity;
        Object.values(game.players).forEach((player) => {
            if (player.isEliminated)
                return;
            const diff = target - player.number;
            if (diff >= 0 && diff < minDiff) {
                minDiff = diff;
                winner = player;
            }
        });
        game.average = average;
        game.target = target;
        game.winner = winner;
        // Update scores and elimination status
        Object.values(game.players).forEach((player) => {
            if (player.isEliminated)
                return;
            if (player.playerId === winner?.playerId) {
                player.score += WIN_SCORE;
            }
            else {
                player.score += LOSE_SCORE;
                player.isEliminated = true;
            }
        });
        // Send results to all players
        io.to(gameId).emit("roundResult", {
            average,
            target,
            winner,
            players: game.players,
            round: game.round,
        });
        // Prepare for next round or end game
        setTimeout(() => {
            if (game.round >= MAX_ROUNDS ||
                Object.values(game.players).filter((p) => !p.isEliminated).length <= 1) {
                endGame(gameId);
            }
            else {
                startNewRound(gameId);
            }
        }, 5000);
    };
    const startNewRound = (gameId) => {
        const game = activeGames.get(gameId);
        if (!game)
            return;
        game.round++;
        game.status = "playing";
        game.average = undefined;
        game.target = undefined;
        game.winner = undefined;
        // Reset numbers for active players
        Object.values(game.players).forEach((player) => {
            if (!player.isEliminated) {
                player.number = null;
            }
        });
        io.to(gameId).emit("newRound", {
            round: game.round,
            players: game.players,
        });
        startCountdown(gameId);
    };
    const endGame = (gameId) => {
        const game = activeGames.get(gameId);
        if (!game)
            return;
        game.status = "finished";
        clearInterval(game.timer);
        // Determine final winner (highest score)
        const finalScores = Object.values(game.players).map((p) => p.score);
        const maxScore = Math.max(...finalScores);
        const finalWinners = Object.values(game.players).filter((p) => p.score === maxScore);
        io.to(gameId).emit("gameOver", {
            winners: finalWinners,
            players: game.players,
        });
        // Clean up after delay
        setTimeout(() => {
            activeGames.delete(gameId);
        }, 30000); // Keep game data for 30 seconds after ending
    };
    const generateGameId = () => {
        return Math.floor(1000 + Math.random() * 9000).toString();
    };
    io.on("connection", (socket) => {
        socket.on("createGame", ({ playerName, rounds = 5 }, callback) => {
            let gameId = generateGameId();
            // Prevent duplicate game IDs (extremely unlikely with 4 digits)
            if (activeGames.has(gameId)) {
                callback({ error: "Failed to create game. Please try again." });
                return;
            }
            MAX_ROUNDS = Math.max(1, Math.min(10, rounds));
            activeGames.set(gameId, {
                players: {},
                status: "waiting",
                round: 0,
                countdown: 0,
                timer: null,
            });
            // Join the creator to the game
            socket.join(gameId);
            const game = activeGames.get(gameId);
            game.players[socket.id] = {
                playerId: socket.id,
                playerName,
                number: null,
                score: 0,
                isEliminated: false,
            };
            // Return the game ID to the creator
            callback({ gameId });
            // Notify the creator that they've joined
            io.to(gameId).emit("updatePlayers", Object.values(game.players));
        });
        // Create or join a game room
        socket.on("joinGame", ({ gameId, playerName = "unknown" }, callback) => {
            const game = activeGames.get(gameId);
            console.log(game, "game");
            // Validate game exists
            if (!game) {
                callback({ error: "gameId is wrong please create another game" });
                return;
            }
            if (game.status !== "waiting") {
                callback({ error: "Game has already started" });
                return;
            }
            socket.join(gameId);
            if (!activeGames.has(gameId)) {
                activeGames.set(gameId, {
                    players: {},
                    status: "waiting",
                    round: 0,
                    countdown: 0,
                    timer: null,
                });
            }
            game.players[socket.id] = {
                playerId: socket.id,
                playerName,
                number: null,
                score: 0,
                isEliminated: false,
            };
            callback({ gameId });
            io.to(gameId).emit("updatePlayers", Object.values(game.players));
            // Start game when 4 players join
            if (Object.keys(game.players).length === 4) {
                game.status = "playing";
                game.round = 1;
                io.to(gameId).emit("gameStarted");
                startCountdown(gameId);
            }
        });
        socket.on("profile", ({ gameId, playerId }, callback) => {
            const game = activeGames.get(gameId);
            // Validate game exists
            if (!game) {
                callback({ error: "gameId is wrong please create another game" });
                return;
            }
            const currentPlayer = game.players.filter((p) => p.playerId === playerId);
            console.log(currentPlayer, "current player");
            if (currentPlayer.length <= 0) {
                callback({ error: "player is not  found", success: false });
            }
            if (game.status !== "waiting") {
                callback({ error: "Game has already started" });
                return;
            }
            callback({ game: game });
        });
        // Handle number submission
        socket.on("submitNumber", ({ gameId, number }) => {
            const game = activeGames.get(gameId);
            if (!game || game.status !== "playing")
                return;
            const player = game.players[socket.id];
            if (player && !player.isEliminated) {
                player.number = Math.max(1, Math.min(100, number)); // Ensure number is between 1-100
                io.to(gameId).emit("playerSubmitted", { playerId: socket.id });
                // Check if all active players submitted
                const allSubmitted = Object.values(game.players)
                    .filter((p) => !p.isEliminated)
                    .every((p) => p.number !== null);
                if (allSubmitted) {
                    clearInterval(game.timer);
                    evaluateRound(gameId);
                }
            }
        });
        // Handle disconnections
        socket.on("disconnect", () => {
            // Find and remove player from any games they're in
            activeGames.forEach((game, gameId) => {
                if (game.players[socket.id]) {
                    delete game.players[socket.id];
                    io.to(gameId).emit("playerLeft", socket.id);
                    // If no players left, end the game
                    if (Object.keys(game.players).length === 0) {
                        clearInterval(game.timer);
                        activeGames.delete(gameId);
                    }
                }
            });
        });
    });
};

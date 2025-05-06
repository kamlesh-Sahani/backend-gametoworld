import { getIO } from "../utils/socket.util.js";

interface PlayerType {
  playerId: string;
  playerName: string;
  number: number | null;
  score: number;
  isEliminated: boolean;
  owner?: boolean;
  isHost?: boolean;
}

interface RoundResult {
  round: number;
  average?: number;
  target?: number;
  winner?: PlayerType | null;
  players: PlayerType[];
}

interface GameType {
  players: Record<string, PlayerType>;
  status: "waiting" | "counting" | "playing" | "finished";
  round: number;
  countdown: number;
  timer: NodeJS.Timeout | null;
  average?: number;
  target?: number;
  winner?: PlayerType | null;
  roundHistory: RoundResult[]; // Added to track all rounds' results
}

export const initThe08Paradox = () => {
  const io = getIO();
  const activeGames = new Map<string, GameType>();
  const ROUND_DURATION = 10; // seconds
  let MAX_ROUNDS = 5;
  const WIN_SCORE = 3;
  const LOSE_SCORE = -3;

  const startCountdown = (gameId: string) => {
    const game = activeGames.get(gameId);
    if (!game) return;

    game.countdown = ROUND_DURATION;
    game.status = "counting";

    // Update all players every second
    game.timer = setInterval(() => {
      game.countdown--;
      io.to(gameId).emit("countdownUpdate", game.countdown);

      if (game.countdown <= 0) {
        clearInterval(game.timer as NodeJS.Timeout);
        evaluateRound(gameId);
      }
    }, 1000);
  };

  const evaluateRound = (gameId: string) => {
    const game = activeGames.get(gameId);
    if (!game) return;

    game.status = "finished";

    // Set null for players who didn't submit in time
    Object.values(game.players).forEach((player) => {
      if (!player.number) {
        player.number = 0; // Consider 0 as automatic choice if not submitted
      }
    });
    const numbers = Object.values(game.players).map((p) => p.number as number);
    if (numbers.length === 0) return;
    const average = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    const target = Math.floor(average * 0.8);

    // Find the winner (closest number ≤ target)
    let winner: PlayerType | null = null;
    let minDiff = Infinity;

    Object.values(game.players).forEach((player) => {
      if (player.isEliminated) return;

      let diff = target - (player.number as number);
      diff = diff > 0 ? diff : -diff;
      if (diff < minDiff) {
        minDiff = diff;
        winner = player;
      }
    });

    game.average = average;
    game.target = target;
    game.winner = winner;

    // Update scores and elimination status
    Object.values(game.players).forEach((player) => {
      if (player.isEliminated) return;

      if (player.playerId === winner?.playerId) {
        player.score += WIN_SCORE;
      } else {
        player.score += LOSE_SCORE;
      }
    });

    // Store round result in history
    const roundResult: RoundResult = {
      round: game.round,
      average,
      target,
      winner,
      players: JSON.parse(JSON.stringify(Object.values(game.players))), // Deep copy
    };
    game.roundHistory.push(roundResult);

    // Send results to all players
    io.to(gameId).emit("roundResult", {
      average,
      target,
      winner,
      players: Object.values(game.players),
      round: game.round,
    });

  

    // Prepare for next round or end game
    setTimeout(() => {
      if (game.round >= MAX_ROUNDS) {
        endGame(gameId);
      } else {
        startNewRound(gameId);
      }
    }, 5000);
  };

  const startNewRound = (gameId: string) => {
    const game = activeGames.get(gameId);

    if (!game) return;

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
      players: Object.values(game.players),
    });

    startCountdown(gameId);
  };

  const endGame = (gameId: string) => {
    const game = activeGames.get(gameId);
    if (!game) return;

    game.status = "finished";
    clearInterval(game.timer as NodeJS.Timeout);

    // Determine final winner (highest score)
    const finalScores = Object.values(game.players).map((p) => p.score);
    const maxScore = Math.max(...finalScores);
    const finalWinners = Object.values(game.players).filter(
      (p) => p.score === maxScore
    );

    io.to(gameId).emit("gameOver", {
      winners: finalWinners[0],
      players: Object.values(game.players),
      roundHistory: game.roundHistory, // Send all rounds' results
    });

    // Clean up after delay
    setTimeout(() => {
      activeGames.delete(gameId);
    }, 30000); // Keep game data for 30 seconds after ending
  };

  const generateGameId = (): string => {
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluded easily confused chars (0,1,I,O)
    let result = '';
    for (let i = 0; i < 4; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  };

  io.on("connection", (socket) => {
    socket.on("createGame", ({ playerName, rounds = 5 }, callback) => {
      let gameId = generateGameId();
      if (activeGames.has(gameId)) {
        callback({ error: "Failed to create game. Please try again." });
        return;
      }

      MAX_ROUNDS = rounds;
      activeGames.set(gameId, {
        players: {},
        status: "waiting",
        round: 0,
        countdown: 0,
        timer: null,
        roundHistory: [], // Initialize round history
      });

      // Join the creator to the game
      socket.join(gameId);
      const game = activeGames.get(gameId) as GameType;

      game.players[socket.id] = {
        playerId: socket.id,
        playerName,
        number: null,
        score: 0,
        isEliminated: false,
        owner: true,
        isHost: true,
      };

      // Return the game ID to the creator
      callback({ gameId });

      // Notify the creator that they've joined
      io.to(gameId).emit("updatePlayers", Object.values(game.players));
    });

    socket.on("joinGame", ({ gameId, playerName = "unknown" }, callback) => {
      const game = activeGames.get(gameId);

      if (!game) {
        callback({ error: "Game not found" });
        return;
      }

      if (game.status !== "waiting") {
        callback({ error: "Game has already started" });
        return;
      }

      // Check if player already exists
      if (game.players[socket.id]) {
        callback({ error: "You're already in this game" });
        return;
      }

      socket.join(gameId);

      game.players[socket.id] = {
        playerId: socket.id,
        playerName,
        number: null,
        score: 0,
        isEliminated: false,
        isHost: false,
      };
      callback({ gameId });
      io.to(gameId).emit("updatePlayers", Object.values(game.players));
    });

    socket.on("profile", ({ gameId, playerId }, callback) => {
      const game = activeGames.get(gameId);

      if (!game) {
        callback({ error: "Game not found", success: false });
        return;
      }

      const currentPlayer = game.players[playerId];

      if (!currentPlayer) {
        callback({ error: "Player not found in this game", success: false });
        return;
      }

      callback({
        success: true,
        gameStatus: game.status,
        player: currentPlayer,
      });
    });

    // New endpoint to get all rounds' results
    socket.on("getRoundHistory", ({ gameId }, callback) => {
      const game = activeGames.get(gameId);

      if (!game) {
        callback({ error: "Game not found", success: false });
        return;
      }

      callback({
        success: true,
        roundHistory: game.roundHistory,
        currentRound: game.round,
        gameStatus: game.status,
      });
    });

    socket.on("submitNumber", ({ gameId, number, playerId }) => {
      const game = activeGames.get(gameId);
      if (!game || game.status !== "counting") return;

      const player = game.players[playerId];
      if (player && !player.isEliminated) {
        player.number = number;
      }
    });

    socket.on("startGame", ({ gameId, playerId }, callback) => {
      const game = activeGames.get(gameId);
      const isOwner = game?.players[playerId];
      if (!isOwner) {
        callback({ error: "your are not the owner" });
        return;
      }
      if (!game) {
        callback({ error: "game is not found" });
        return;
      }
      if (Object.values(game.players).length <= 1) {
        callback({ error: "player should be more than 1" });
        return;
      }
      game.status = "playing";

      game.round = 1;
      io.to(gameId).emit("gameStarted");
      startCountdown(gameId);
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
            clearInterval(game.timer as NodeJS.Timeout);
            activeGames.delete(gameId);
          }
        }
      });
    });
  });
};

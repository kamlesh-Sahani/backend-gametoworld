import { getIO } from "../utils/socket.util.js";


// Game state storage
const games = new Map();

// Player data storage
const players = new Map();

// Game constants
const COLORS = ['red', 'blue', 'green', 'yellow'];
const VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
const WILDS = ['wild', 'wild_draw4'];

export const initUnoGame = () => {
  const io = getIO();

  // Initialize namespaces
  const gameNamespace = io.of('/uno');

  gameNamespace.on('connection', (socket) => {
    console.log(`New connection in uno: ${socket.id}`);

    // Player joining a room
    socket.on('joinGame', async ({ gameId, playerName }, callback) => {
      try {
        // Validate input
        if (!gameId || !playerName) {
          throw new Error('Game ID and player name are required');
        }

        // Initialize game if it doesn't exist
        if (!games.has(gameId)) {
          games.set(gameId, {
            players: [],
            deck: [],
            discardPile: [],
            currentPlayer: 0,
            direction: 1,
            status: 'waiting', // waiting, playing, finished
            currentColor: null,
            creator: socket.id,
            settings: {
              maxPlayers: 4,
              scoreLimit: 500,
              allowStacking: false
            }
          });
        }

        const game = games.get(gameId);
        console.log(game,"game uno")
        
        // Check if game is full
        if (game.players.length >= game.settings.maxPlayers) {
          throw new Error('Game is full');
        }

        // Check if player name is already taken
        if (game.players.some(p => p.name === playerName)) {
          throw new Error('Player name already taken');
        }

        // Add player to game
        const player = {
          id: socket.id,
          name: playerName,
          hand: [],
          score: 0,
          avatar: `https://i.pravatar.cc/150?u=${socket.id}`
        };

        game.players.push(player);
        players.set(socket.id, { gameId, playerName });

        // Join the room
        await socket.join(gameId);

        // Notify others
        socket.to(gameId).emit('playerJoined', player);

        // Return current game state
        callback({
          success: true,
          gameState: filterGameState(game, socket.id),
          players: game.players
        });

        console.log(`${playerName} joined game ${gameId}`);
      } catch (error) {
        callback({
          success: false,
          error: error.message
        });
      }
    });

    // Start the game
    socket.on('startGame', ({ gameId }, callback) => {
      try {
        const game = games.get(gameId);
        
        if (!game) {
          throw new Error('Game not found');
        }

        if (game.creator !== socket.id) {
          throw new Error('Only the game creator can start the game');
        }

        if (game.players.length < 2) {
          throw new Error('Need at least 2 players to start');
        }

        // Initialize deck
        game.deck = createDeck();
        
        // Deal cards to each player
        game.players.forEach(player => {
          player.hand = [];
          for (let i = 0; i < 7; i++) {
            player.hand.push(game.deck.pop());
          }
        });

        // Put first card on discard pile
        let firstCard;
        do {
          firstCard = game.deck.pop();
        } while (firstCard.color === 'black');

        game.discardPile = [firstCard];
        game.currentColor = firstCard.color;
        game.currentPlayer = 0;
        game.status = 'playing';
        game.lastPlayedCard = firstCard;

        // Broadcast game started
        gameNamespace.to(gameId).emit('gameStarted', filterGameState(game));

        callback({ success: true });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    });

    // Player plays a card
    socket.on('playCard', ({ gameId, cardIndex }, callback) => {
      try {
        const game = games.get(gameId);
        const player = game.players.find(p => p.id === socket.id);

        if (!game || !player) {
          throw new Error('Game or player not found');
        }

        if (game.status !== 'playing') {
          throw new Error('Game is not in progress');
        }

        if (game.currentPlayer !== game.players.findIndex(p => p.id === socket.id)) {
          throw new Error('Not your turn');
        }

        const card = player.hand[cardIndex];
        const topCard = game.discardPile[game.discardPile.length - 1];

        // Validate card play
        if (card.color !== 'black' && card.color !== game.currentColor && card.value !== topCard.value) {
          throw new Error('Invalid card play');
        }

        // Remove card from player's hand
        player.hand.splice(cardIndex, 1);

        // Add to discard pile
        game.discardPile.push(card);
        game.lastPlayedCard = card;

        // Check for win condition
        if (player.hand.length === 0) {
          const roundScore = calculateRoundScore(game.players);
          player.score += roundScore;
          game.status = 'finished';
          
          gameNamespace.to(gameId).emit('playerWon', {
            playerId: player.id,
            playerName: player.name,
            score: roundScore
          });

          callback({ success: true });
          return;
        }

        // Handle special cards
        handleSpecialCard(game, card);

        // Set current color (for wild cards)
        if (card.color === 'black') {
          // Client will prompt for color and send setColor event
          callback({ success: true, requiresColorChoice: true });
          return;
        } else {
          game.currentColor = card.color;
        }

        // Update game state and notify all players
        gameNamespace.to(gameId).emit('cardPlayed', {
          playerId: player.id,
          card,
          gameState: filterGameState(game)
        });

        callback({ success: true });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    });

    // Player sets color after playing wild card
    socket.on('setColor', ({ gameId, color }, callback) => {
      try {
        const game = games.get(gameId);
        
        if (!game) {
          throw new Error('Game not found');
        }

        if (!COLORS.includes(color)) {
          throw new Error('Invalid color');
        }

        game.currentColor = color;

        // Notify all players
        gameNamespace.to(gameId).emit('colorChanged', {
          color,
          gameState: filterGameState(game)
        });

        callback({ success: true });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    });

    // Player draws a card
    socket.on('drawCard', ({ gameId }, callback) => {
      try {
        const game = games.get(gameId);
        const player = game.players.find(p => p.id === socket.id);

        if (!game || !player) {
          throw new Error('Game or player not found');
        }

        if (game.status !== 'playing') {
          throw new Error('Game is not in progress');
        }

        if (game.currentPlayer !== game.players.findIndex(p => p.id === socket.id)) {
          throw new Error('Not your turn');
        }

        // Reshuffle discard pile if deck is empty
        if (game.deck.length === 0) {
          const topCard = game.discardPile.pop();
          game.deck = shuffleDeck([...game.discardPile]);
          game.discardPile = [topCard];
        }

        const drawnCard = game.deck.pop();
        player.hand.push(drawnCard);

        // Check if card can be played immediately
        const topCard = game.discardPile[game.discardPile.length - 1];
        const canPlay = drawnCard.color === 'black' || 
                      drawnCard.color === game.currentColor || 
                      drawnCard.value === topCard.value;

        // Update game state
        gameNamespace.to(gameId).emit('cardDrawn', {
          playerId: player.id,
          card: drawnCard,
          canPlay,
          gameState: filterGameState(game)
        });

        callback({ 
          success: true,
          card: drawnCard,
          canPlay
        });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    });

    // Player leaves the game
    socket.on('leaveGame', ({ gameId }) => {
      const game = games.get(gameId);
      if (game) {
        const playerIndex = game.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
          const player = game.players[playerIndex];
          game.players.splice(playerIndex, 1);
          
          // Notify other players
          socket.to(gameId).emit('playerLeft', player);

          // Clean up if game is empty
          if (game.players.length === 0) {
            games.delete(gameId);
          }
        }
      }
      players.delete(socket.id);
      socket.leave(gameId);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      const playerData = players.get(socket.id);
      if (playerData) {
        const { gameId } = playerData;
        const game = games.get(gameId);
        
        if (game) {
          const playerIndex = game.players.findIndex(p => p.id === socket.id);
          if (playerIndex !== -1) {
            const player = game.players[playerIndex];
            game.players.splice(playerIndex, 1);
            
            // Notify other players
            socket.to(gameId).emit('playerDisconnected', player);

            // Clean up if game is empty
            if (game.players.length === 0) {
              games.delete(gameId);
            }
          }
        }
        players.delete(socket.id);
      }
      console.log(`Disconnected: ${socket.id}`);
    });
  });
};

// Helper functions
function createDeck() {
  const deck = [];
  
  // Add colored cards
  COLORS.forEach(color => {
    VALUES.forEach(value => {
      if (value === '0') {
        deck.push({ color, value });
      } else {
        deck.push({ color, value });
        deck.push({ color, value });
      }
    });
  });
  
  // Add wild cards
  WILDS.forEach(wild => {
    for (let i = 0; i < 4; i++) {
      deck.push({ color: 'black', value: wild });
    }
  });
  
  return shuffleDeck(deck);
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function handleSpecialCard(game, card) {
  const nextPlayerIndex = () => {
    let next = game.currentPlayer + game.direction;
    if (next >= game.players.length) next = 0;
    if (next < 0) next = game.players.length - 1;
    return next;
  };

  switch (card.value) {
    case 'skip':
      game.currentPlayer = nextPlayerIndex();
      break;
    case 'reverse':
      game.direction *= -1;
      break;
    case 'draw2':
      const nextPlayer = game.players[nextPlayerIndex()];
      for (let i = 0; i < 2; i++) {
        if (game.deck.length === 0) {
          const topCard = game.discardPile.pop();
          game.deck = shuffleDeck([...game.discardPile]);
          game.discardPile = [topCard];
        }
        nextPlayer.hand.push(game.deck.pop());
      }
      break;
    case 'wild_draw4':
      const nextP = game.players[nextPlayerIndex()];
      for (let i = 0; i < 4; i++) {
        if (game.deck.length === 0) {
          const topCard = game.discardPile.pop();
          game.deck = shuffleDeck([...game.discardPile]);
          game.discardPile = [topCard];
        }
        nextP.hand.push(game.deck.pop());
      }
      break;
  }

  // Move to next player unless the card changes the current player
  if (!['skip', 'reverse'].includes(card.value)) {
    game.currentPlayer = nextPlayerIndex();
  }
}

function calculateRoundScore(players) {
  let score = 0;
  players.forEach(player => {
    player.hand.forEach(card => {
      if (card.color === 'black') {
        score += 50;
      } else if (isNaN(card.value)) {
        score += 20;
      } else {
        score += parseInt(card.value);
      }
    });
  });
  return score;
}

function filterGameState(game, playerId = null) {
  // Return a filtered game state that doesn't reveal other players' hands
  return {
    deckCount: game.deck.length,
    discardPile: game.discardPile,
    currentPlayer: game.currentPlayer,
    direction: game.direction,
    status: game.status,
    currentColor: game.currentColor,
    lastPlayedCard: game.lastPlayedCard,
    players: game.players.map(player => ({
      id: player.id,
      name: player.name,
      score: player.score,
      cardCount: player.hand.length,
      // Only include full hand data for the requesting player
      hand: player.id === playerId ? player.hand : undefined,
      avatar: player.avatar
    })),
    settings: game.settings
  };
}
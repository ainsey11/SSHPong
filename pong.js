const fs = require('fs');
const crypto = require('crypto');
const ssh2 = require('ssh2');

// Generate or load host key
let hostKey;
if (fs.existsSync('host_key')) {
  hostKey = fs.readFileSync('host_key');
} else {
  hostKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  fs.writeFileSync('host_key', hostKey);
}

// Game state
let gameState = {
  paddleLeft: 0,
  paddleRight: 0,
  ballX: 0,
  ballY: 0,
  ballSpeedX: 0.5,
  ballSpeedY: 0.5,
  scoreLeft: 0,
  scoreRight: 0,
  paused: false,
  rows: 24,
  columns: 80
};

// Game loop
function gameLoop(stream) {
  if (gameState.paused) {
    setTimeout(() => gameLoop(stream), 50);
    return;
  }

  // Update ball position
  gameState.ballX += gameState.ballSpeedX;
  gameState.ballY += gameState.ballSpeedY;

  // Check collisions with walls
  if (gameState.ballY <= 0 || gameState.ballY >= gameState.rows - 1) {
    gameState.ballSpeedY *= -1;
  }

  // Check collisions with paddles
  if (gameState.ballX <= 1 && gameState.ballY >= gameState.paddleLeft && gameState.ballY <= gameState.paddleLeft + 5) {
    gameState.ballSpeedX = Math.abs(gameState.ballSpeedX);
    gameState.ballSpeedY += (Math.random() - 0.5) * 0.2; // Reduced randomness
  }
  if (gameState.ballX >= gameState.columns - 2 && gameState.ballY >= gameState.paddleRight && gameState.ballY <= gameState.paddleRight + 5) {
    gameState.ballSpeedX = -Math.abs(gameState.ballSpeedX);
    gameState.ballSpeedY += (Math.random() - 0.5) * 0.2; // Reduced randomness
  }

  // Ensure ball stays within vertical bounds
  gameState.ballY = Math.max(0, Math.min(gameState.rows - 1, gameState.ballY));

  // Check for scoring
  if (gameState.ballX < 0) {
    gameState.scoreRight++;
    resetBall();
  } else if (gameState.ballX >= gameState.columns) {
    gameState.scoreLeft++;
    resetBall();
  }

  // Move AI paddle
  moveAIPaddle();

  // Render game
  renderGame(stream);

  // Schedule next frame
  setTimeout(() => gameLoop(stream), 50);
}

function resetBall() {
  gameState.ballX = Math.floor(gameState.columns / 2);
  gameState.ballY = Math.floor(gameState.rows / 2);
  gameState.ballSpeedX = (Math.random() > 0.5 ? 0.5 : -0.5) * (0.8 + Math.random() * 0.4);
  gameState.ballSpeedY = (Math.random() > 0.5 ? 0.5 : -0.5) * (0.8 + Math.random() * 0.4);
}

function moveAIPaddle() {
  const paddleCenter = gameState.paddleRight + 2.5;
  const moveSpeed = 0.4; // Slightly reduced AI speed

  if (gameState.ballY < paddleCenter - 1) {
    gameState.paddleRight = Math.max(0, gameState.paddleRight - moveSpeed);
  } else if (gameState.ballY > paddleCenter + 1) {
    gameState.paddleRight = Math.min(gameState.rows - 6, gameState.paddleRight + moveSpeed);
  }
}

function renderGame(stream) {
  let output = '\x1b[2J\x1b[H'; // Clear screen and move cursor to top-left

  // Render paddles
  for (let i = 0; i < 6; i++) {
    output += `\x1b[${Math.floor(gameState.paddleLeft) + i + 1};1H\x1b[32m|\x1b[0m`;
    output += `\x1b[${Math.floor(gameState.paddleRight) + i + 1};${gameState.columns}H\x1b[32m|\x1b[0m`;
  }

  // Render middle bar
  for (let i = 0; i < gameState.rows; i++) {
    output += `\x1b[${i + 1};${Math.floor(gameState.columns / 2)}H\x1b[37m|\x1b[0m`;
  }

  // Render ball
  output += `\x1b[${Math.floor(gameState.ballY) + 1};${Math.floor(gameState.ballX) + 1}H\x1b[31m●\x1b[0m`;

  // Render player/computer indicators and scores
  output += `\x1b[${gameState.rows};${Math.floor(gameState.columns / 4) - 10}H\x1b[36mPLAYER: ${gameState.scoreLeft}\x1b[0m`;
  output += `\x1b[${gameState.rows};${Math.floor(3 * gameState.columns / 4) - 14}H\x1b[36mCOMPUTER: ${gameState.scoreRight}\x1b[0m`;

  stream.write(output);
}

// Function to start the game
function startGame(stream) {
  // Initialize game state
  gameState.paddleLeft = Math.floor(gameState.rows / 2) - 3;
  gameState.paddleRight = Math.floor(gameState.rows / 2) - 3;
  resetBall();

  // Handle input
  stream.on('data', (data) => {
    const key = data.toString();
    if (key === '\u001b') { // ESC key
      gameState.paused = !gameState.paused;
      if (!gameState.paused) gameLoop(stream);
    } else if (key === 'w' && gameState.paddleLeft > 0) {
      gameState.paddleLeft -= 1;
    } else if (key === 's' && gameState.paddleLeft < gameState.rows - 6) {
      gameState.paddleLeft += 1;
    }
  });

  // Start game loop
  gameLoop(stream);
}

// SSH server
new ssh2.Server({
  hostKeys: [hostKey]
}, (client) => {
  console.log('Client connected!');

  client.on('authentication', (ctx) => {
    // Accept any authentication
    ctx.accept();
  });

  client.on('ready', () => {
    console.log('Client authenticated!');

    client.on('session', (accept, reject) => {
      const session = accept();
      
      session.on('pty', (accept, reject, info) => {
        console.log('PTY requested');
        if (info && info.rows && info.cols) {
          gameState.rows = info.rows;
          gameState.columns = info.cols;
        }
        accept();
      });

      session.on('shell', (accept, reject) => {
        const stream = accept();
        console.log('Shell requested');
        stream.write('Welcome to Pong! Use W/S to move. ESC to pause. No commands allowed.\n\r');
        // Start the game after a short delay to ensure the welcome message is displayed
        setTimeout(() => startGame(stream), 1000);
      });

      session.on('exec', (accept, reject, info) => {
        console.log('Exec requested');
        const stream = accept();
        stream.write('Welcome to Pong! Use W/S to move. ESC to pause. No commands allowed.\n\r');
        // Start the game after a short delay to ensure the welcome message is displayed
        setTimeout(() => startGame(stream), 1000);
      });

      session.on('window-change', (accept, reject, info) => {
        if (info && info.rows && info.cols) {
          gameState.rows = info.rows;
          gameState.columns = info.cols;
        }
      });
    });
  });
}).listen(2244, '0.0.0.0', function() {
  console.log('Pong SSH server listening on port 2244');
});
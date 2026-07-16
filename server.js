const path = require('path');

const botServerPath = path.join(__dirname, 'whatsapp-viewonce-bot', 'server.js');

try {
  const { startServer } = require(botServerPath);
  startServer();
} catch (error) {
  console.error(`Failed to start bot server from ${botServerPath}:`, error);
  process.exit(1);
}

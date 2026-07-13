const http = require('http');
const fs = require('fs');
const path = require('path');
// Import your bot connecting function directly from bot.js instead of using spawn
const { startBotSessionInline } = require('./bot'); 
const { addUser, deleteSession, listQrFiles, loadUsers } = require('./session-manager');

const rootDir = __dirname;
const htmlFile = path.join(rootDir, 'qr-web.html');
const sessionsDir = path.join(rootDir, 'sessions');
const qrCache = new Map();
const activeSessions = new Map(); // Track live inline sessions

function serveFile(filePath, contentType, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

// Rewritten function to run directly in the same cloud process without spawning separate windows
function startBotSession(phoneNumber) {
  if (activeSessions.has(phoneNumber)) {
    return { ok: true, message: 'Session already active inline', number: phoneNumber };
  }

  try {
    // Spin up the bot internally and handle QR code state callbacks dynamically
    startBotSessionInline(phoneNumber, (qrDataUrl) => {
      if (qrDataUrl) {
        qrCache.set(phoneNumber, qrDataUrl);
      }
    });

    activeSessions.set(phoneNumber, true);

    return {
      ok: true,
      number: phoneNumber,
      message: "Session initiated successfully inside cloud process"
    };
  } catch (error) {
    console.error(`Error starting inline session for ${phoneNumber}:`, error);
    return { ok: false, message: error.message };
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    serveFile(htmlFile, 'text/html; charset=utf-8', res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/qrs') {
    const qrs = Array.from(qrCache.entries()).map(([name, dataUrl]) => ({ name, dataUrl }));
    sendJson(res, qrs);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/users') {
    sendJson(res, loadUsers());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/users') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { number } = JSON.parse(body || '{}');
        if (!number) {
          sendJson(res, { ok: false, message: 'Phone number is required' }, 400);
          return;
        }

        const added = addUser(number);
        const started = startBotSession(number);
        sendJson(res, { ok: true, added, started, number });
      } catch (error) {
        sendJson(res, { ok: false, message: 'Invalid request body' }, 400);
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { number } = JSON.parse(body || '{}');
        if (!number) {
          sendJson(res, { ok: false, message: 'Phone number is required' }, 400);
          return;
        }

        const result = startBotSession(number);
        sendJson(res, { ok: true, number, result });
      } catch (error) {
        sendJson(res, { ok: false, message: error.message }, 500);
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/remove') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { number } = JSON.parse(body || '{}');
        if (!number) {
          sendJson(res, { ok: false, message: 'Phone number is required' }, 400);
          return;
        }

        const result = deleteSession(number);
        activeSessions.delete(number);
        qrCache.delete(number);
        sendJson(res, { ok: true, result });
      } catch (error) {
        sendJson(res, { ok: false, message: 'Invalid request body' }, 400);
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/qr/')) {
    const name = decodeURIComponent(url.pathname.replace('/qr/', ''));
    const qrPath = path.join(sessionsDir, name, 'qr.png');
    if (fs.existsSync(qrPath)) {
      serveFile(qrPath, 'image/png', res);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

function startAllSessions() {
  const users = loadUsers();
  if (!users.length) {
    console.log('⚠️  No registered users to start.');
    return;
  }

  console.log(`\n🚀 Starting ${users.length} registered session(s) inline...\n`);
  for (const user of users) {
    startBotSession(user.number);
  }
}

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`QR web page running at http://localhost:${port}`);
  console.log('Server is listening. Launching registered sessions...');
  setImmediate(startAllSessions);
});
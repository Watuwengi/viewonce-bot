const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { addUser, deleteSession, listQrFiles, loadUsers } = require('./session-manager');

const rootDir = __dirname;
const htmlFile = path.join(rootDir, 'qr-web.html');
const sessionsDir = path.join(rootDir, 'sessions');

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

function startBotSession(phoneNumber) {
  const sessionDir = path.join(rootDir, 'sessions', phoneNumber);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const logPath = path.join(sessionDir, 'bot.log');
  const logStream = fs.openSync(logPath, 'a');

  const child = spawn(process.execPath, ['bot.js', phoneNumber], {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', logStream, logStream],
    shell: false,
  });

  child.unref();

  return {
    ok: true,
    number: phoneNumber,
    pid: child.pid,
    logPath,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    serveFile(htmlFile, 'text/html; charset=utf-8', res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/qrs') {
    sendJson(res, listQrFiles());
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

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`QR web page running at http://localhost:${port}`);
});

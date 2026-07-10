const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const USERS_FILE = path.join(ROOT_DIR, 'users.json');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');

function ensureUsersFile() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, '[]');
  }
}

function loadUsers() {
  ensureUsersFile();
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function addUser(phoneNumber) {
  const users = loadUsers();
  if (users.find((user) => user.number === phoneNumber)) {
    return false;
  }

  users.push({ number: phoneNumber, addedAt: new Date().toISOString() });
  saveUsers(users);
  return true;
}

function deleteSession(phoneNumber) {
  const users = loadUsers();
  const filtered = users.filter((user) => user.number !== phoneNumber);
  const removedFromUsers = filtered.length !== users.length;

  if (removedFromUsers) {
    saveUsers(filtered);
  }

  const sessionDir = path.join(SESSIONS_DIR, phoneNumber);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  return {
    phoneNumber,
    removedFromUsers,
    sessionDir,
  };
}

function listQrFiles() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    return [];
  }

  return fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const qrPath = path.join(SESSIONS_DIR, entry.name, 'qr.png');
      if (!fs.existsSync(qrPath)) return null;

      return {
        name: entry.name,
        path: `/qr/${encodeURIComponent(entry.name)}`,
      };
    })
    .filter(Boolean);
}

module.exports = {
  ROOT_DIR,
  USERS_FILE,
  SESSIONS_DIR,
  ensureUsersFile,
  loadUsers,
  saveUsers,
  addUser,
  deleteSession,
  listQrFiles,
};

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    downloadMediaMessage, 
    getContentType, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    WAMessageStubType,
    proto
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const readline = require('readline');
const express = require('express');

const ROOT_DIR = __dirname;
const USERS_FILE = path.join(ROOT_DIR, 'users.json');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');

// ── EXPRESS PORT BINDING (Moved up so it launches instantly) ──────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot is running smoothly!');
});

app.listen(PORT, () => {
    console.log(`✅ Web port server successfully active on port ${PORT}`);
    console.log(`🔗 Cron-jobs can now ping this service to prevent idle sleep mode.`);
});

// ── Users helpers ──────────────────────────────────────────────────────────
function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
    return JSON.parse(fs.readFileSync(USERS_FILE));
}
function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function addUser(phoneNumber) {
    const users = loadUsers();
    if (users.find(u => u.number === phoneNumber)) {
        console.log(`⚠️  User ${phoneNumber} already exists`);
        return false;
    }
    users.push({ number: phoneNumber, addedAt: new Date().toISOString() });
    saveUsers(users);
    return true;
}
function deleteSession(phoneNumber) {
    const users = loadUsers();
    const filtered = users.filter(u => u.number !== phoneNumber);
    if (filtered.length === users.length) {
        console.log(`⚠️  ${phoneNumber} not found in users.json`);
    } else {
        saveUsers(filtered);
        console.log(`✅ Removed ${phoneNumber} from users.json`);
    }
    const sessionDir = path.join(SESSIONS_DIR, phoneNumber);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log(`✅ Deleted session folder: ${sessionDir}`);
    } else {
        console.log(`⚠️  No session folder found for ${phoneNumber}`);
    }
}

// ── RL helpers ─────────────────────────────────────────────────────────────
function createRL() {
    return readline.createInterface({ input: process.stdin, output: process.stdout });
}
function ask(rl, q) {
    return new Promise(res => rl.question(q, res));
}

// ── Format deleted message content for notification ───────────────────────
async function buildDeletedNotification(sock, original, senderJid, chatJid) {
    const msg   = original.message;
    const type  = msg ? getContentType(msg) : null;

    if (type === 'conversation' || type === 'extendedTextMessage') {
        const text = msg.conversation || msg.extendedTextMessage?.text || '';
        return {
            kind: 'text',
            text,
            buffer: null,
            mediaKey: null,
        };
    }

    if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type)) {
        try {
            const buffer = await downloadMediaMessage(original, 'buffer', {}, { sock });
            if (buffer && buffer.length > 500) {
                const mediaKey = type === 'imageMessage'   ? 'image'
                               : type === 'videoMessage'   ? 'video'
                               : type === 'audioMessage'   ? 'audio'
                               : type === 'stickerMessage' ? 'sticker'
                               : 'document';
                const caption  = msg[type]?.caption || '';
                return { kind: 'media', buffer, mediaKey, caption, type };
            }
        } catch (_) {}
        return { kind: 'media_failed', type };
    }

    return { kind: 'unknown', type };
}

// ── Start session ──────────────────────────────────────────────────────────
async function startSession(phoneNumber, method = 'qr') {
    const sessionDir = path.join(SESSIONS_DIR, phoneNumber);

    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, 'auth'));
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    let reconnectTimeout = null;
    let reconnecting = false;

    function scheduleReconnect(delay, nextMethod = method) {
        if (reconnectTimeout) return;
        reconnecting = true;
        reconnectTimeout = setTimeout(async () => {
            reconnectTimeout = null;
            reconnecting = false;
            console.log(`[${phoneNumber}] 🔁 Restarting session...`);
            await startSession(phoneNumber, nextMethod);
        }, delay);
    }

    const messageStore = {}; 
    const nameCache    = {}; 
    const MAX_PER_CHAT = 500;

    function storeMessage(msg) {
        if (!msg?.key?.id || !msg.message) return;
        const jid = msg.key.remoteJid;
        if (!messageStore[jid]) messageStore[jid] = {};
        messageStore[jid][msg.key.id] = msg;

        const senderJid = msg.key.participant || msg.key.remoteJid;
        if (msg.pushName && senderJid) {
            nameCache[senderJid] = msg.pushName;
        }

        const ids = Object.keys(messageStore[jid]);
        if (ids.length > MAX_PER_CHAT) {
            delete messageStore[jid][ids[0]];
        }
    }

    function lookupMessage(chatJid, msgId) {
        return messageStore[chatJid]?.[msgId] || null;
    }

    function getName(jid, fallbackMsg) {
        return fallbackMsg?.pushName
            || fallbackMsg?.verifiedBizName
            || nameCache[jid]
            || jid?.split('@')[0]
            || 'Unknown';
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) storeMessage(msg);
    });

    let pairingCodeDone = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr && method === 'code' && !pairingCodeDone) {
            pairingCodeDone = true;
            try {
                const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                console.log(`\n[${phoneNumber}] 🔄 Requesting pairing code for ${cleanNumber}...`);
                const code = await sock.requestPairingCode(cleanNumber);
                const formatted = code?.match(/.{1,4}/g)?.join('-') ?? code;
                console.log(`\n[${phoneNumber}] ╔══════════════════════════════════╗`);
                console.log(`[${phoneNumber}] ║  📲 PAIRING CODE: ${formatted.padEnd(13)} ║`);
                console.log(`[${phoneNumber}] ╚══════════════════════════════════╝`);
            } catch (err) {
                console.error(`[${phoneNumber}] ❌ Pairing code failed: ${err.message}`);
                pairingCodeDone = false;
            }
        }

        if (connection === 'open') {
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
                reconnectTimeout = null;
                reconnecting = false;
            }
            console.log(`\n[${phoneNumber}] ✅ CONNECTED!`);
            console.log(`[${phoneNumber}] 📌 Anti-delete ON | Reply to view-once to save it\n`);
        }

        if (connection === 'close') {
            if (reconnecting) return;
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === 401 || code === 440) {
                console.log(`[${phoneNumber}] 🚫 Logged out (code ${code}). Clearing auth and reconnecting with fresh QR...`);
                try {
                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                        console.log(`[${phoneNumber}] ✅ Cleared session state at ${sessionDir}`);
                    }
                } catch (err) {
                    console.error(`[${phoneNumber}] ❌ Failed to clear session: ${err.message}`);
                }
                scheduleReconnect(2000, 'qr');
            } else {
                console.log(`[${phoneNumber}] 🔄 Reconnecting in 5s...`);
                scheduleReconnect(5000);
            }
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const { key, update } of updates) {
            const isDeleted = update.messageStubType === WAMessageStubType.REVOKE
                           || update.messageStubType === WAMessageStubType.ADMIN_REVOKE
                           || update.message === null;

            if (!isDeleted) continue;

            const deletedMsgId = key.id;
            const chatJid      = key.remoteJid;

            if (key.fromMe) continue;

            const original = lookupMessage(chatJid, deletedMsgId);
            if (!original) continue;

            const senderJid  = original.key.participant || original.key.remoteJid;
            const senderName = getName(senderJid, original);

            const ownerJid = phoneNumber + '@s.whatsapp.net';
            const header   = `🗑️ *Deleted Message*\n👤 From: *${senderName}*\n📞 Number: ${senderJid.split('@')[0]}\n💬 Chat: ${chatJid}\n`;

            try {
                const info = await buildDeletedNotification(sock, original, senderJid, chatJid);

                if (info.kind === 'text') {
                    await sock.sendMessage(ownerJid, { text: header + `\n📝 *Message:*\n${info.text}` });
                } else if (info.kind === 'media') {
                    await sock.sendMessage(ownerJid, {
                        [info.mediaKey]: info.buffer,
                        caption: header + (info.caption ? `\n📝 Caption: ${info.caption}` : '')
                    });
                }
            } catch (err) {
                console.error(`[${phoneNumber}] ❌ Anti-delete error: ${err.message}`);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message || !msg.key.fromMe) continue;

            const from = msg.key.remoteJid;
            const contextInfo = extractContextInfo(msg.message);
            if (!contextInfo?.quotedMessage) continue;

            const viewOnceContent = extractViewOnce(contextInfo.quotedMessage);
            if (!viewOnceContent) continue;

            console.log(`\n[${phoneNumber}] 🔥 View-once reply detected! Forwarding...`);

            const stanzaId    = contextInfo.stanzaId;
            const participant = contextInfo.participant;
            const storedMsg   = lookupMessage(from, stanzaId) || lookupMessage(participant || from, stanzaId);

            let msgToDownload;
            if (storedMsg) {
                const originalContent = extractViewOnce(
                    storedMsg.message?.viewOnceMessage?.message ||
                    storedMsg.message?.viewOnceMessageV2?.message ||
                    storedMsg.message?.viewOnceMessageV2Extension?.message ||
                    storedMsg.message
                ) || viewOnceContent;
                msgToDownload = { key: storedMsg.key, message: originalContent };
            } else {
                msgToDownload = {
                    key: { remoteJid: from, id: stanzaId, fromMe: false, participant: participant || undefined },
                    message: viewOnceContent
                };
            }

            await forwardViewOnce(sock, msgToDownload, from, phoneNumber);
        }
    });
}

function extractContextInfo(message) {
    const types = ['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
    for (const t of types) {
        if (message[t]?.contextInfo) return message[t].contextInfo;
    }
    return null;
}

function extractViewOnce(quoted) {
    if (!quoted) return null;
    if (quoted.viewOnceMessage?.message)            return quoted.viewOnceMessage.message;
    if (quoted.viewOnceMessageV2?.message)          return quoted.viewOnceMessageV2.message;
    if (quoted.viewOnceMessageV2Extension?.message) return quoted.viewOnceMessageV2Extension.message;
    if (quoted.imageMessage || quoted.videoMessage || quoted.audioMessage) return quoted;
    return null;
}

async function forwardViewOnce(sock, msgToDownload, from, phoneNumber) {
    try {
        const buffer = await downloadMediaMessage(msgToDownload, 'buffer', {}, { sock });
        if (!buffer || buffer.length < 500) return;
        const type     = getContentType(msgToDownload.message);
        const ownerJid = phoneNumber + '@s.whatsapp.net';
        const mediaKey = type === 'imageMessage' ? 'image' : type === 'videoMessage' ? 'video' : 'audio';
        await sock.sendMessage(ownerJid, {
            [mediaKey]: buffer,
            caption: `👁️ *View Once*\n📍 From: ${from}`
        });
    } catch (err) {}
}

// ── Connection menu elements ──────────────────────────────────────────────
async function askConnectionMethod(rl, phoneNumber) {
    console.log(`\nHow should ${phoneNumber} connect?`);
    console.log('  1. QR Code');
    console.log('  2. Pairing Code');
    const choice = (await ask(rl, 'Choose (1/2): ')).trim();
    return choice === '2' ? 'code' : 'qr';
}

async function menu() {
    const rl = createRL();
    console.log('\n╔══════════════════════════════════╗');
    console.log('║   WhatsApp View-Once Saver Bot   ║');
    console.log('╚══════════════════════════════════╝\n');

    const users = loadUsers();
    if (users.length > 0) {
        users.forEach((u, i) => console.log(`   ${i + 1}. ${u.number}`));
    }

    console.log('\nOptions:\n  1. Start all existing sessions\n  2. Add new user + connect now\n  3. Add new user only\n  4. Start a specific session\n  5. Delete a session\n');
    const choice = (await ask(rl, 'Choose (1-5): ')).trim();

    if (choice === '1') {
        rl.close();
        if (users.length === 0) return;
        for (const user of users) await startSession(user.number, 'qr');
    } else if (choice === '2') {
        const number = (await ask(rl, 'Enter WhatsApp number: ')).trim();
        const method = await askConnectionMethod(rl, number);
        rl.close();
        addUser(number);
        await startSession(number, method);
    } else if (choice === '3') {
        const number = (await ask(rl, 'Enter WhatsApp number: ')).trim();
        rl.close();
        addUser(number);
    } else if (choice === '4') {
        if (users.length === 0) { rl.close(); return; }
        const idx  = (await ask(rl, `Pick user (1-${users.length}): `)).trim();
        const user = users[parseInt(idx) - 1];
        if (!user) { rl.close(); return; }
        const method = await askConnectionMethod(rl, user.number);
        rl.close();
        await startSession(user.number, method);
    } else if (choice === '5') {
        if (users.length === 0) { rl.close(); return; }
        const idx     = (await ask(rl, `Pick user (1-${users.length}): `)).trim();
        const user    = users[parseInt(idx) - 1];
        if (!user) { rl.close(); return; }
        const confirm = (await ask(rl, `Delete ${user.number}? (yes/no): `)).trim();
        rl.close();
        if (confirm.toLowerCase() === 'yes') deleteSession(user.number);
    } else {
        rl.close();
    }
}

async function startAllSessions() {
    const users = loadUsers();
    if (users.length === 0) {
        console.log('⚠️  No active user sessions configured in users.json yet.');
        return;
    }
    console.log(`\n🚀 Preloading ${users.length} configured sessions...\n`);
    for (const user of users) {
        await startSession(user.number, 'qr');
    }
}

async function main() {
    const cliNumber = process.argv[2];
    const cliMethod = process.argv[3];

    if (cliNumber === '--menu') {
        await menu();
        return;
    }

    if (cliNumber === '--all' || !cliNumber) {
        await startAllSessions();
        return;
    }

    const method = cliMethod === 'code' ? 'code' : 'qr';
    await startSession(cliNumber, method);
}

main().catch((err) => {
    console.error('❌ Startup error:', err);
    process.exit(1);
});
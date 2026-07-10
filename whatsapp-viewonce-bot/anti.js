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

const ROOT_DIR = __dirname;
const USERS_FILE = path.join(ROOT_DIR, 'users.json');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');

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

    // Text message
    if (type === 'conversation' || type === 'extendedTextMessage') {
        const text = msg.conversation || msg.extendedTextMessage?.text || '';
        return {
            kind: 'text',
            text,
            buffer: null,
            mediaKey: null,
        };
    }

    // Media message — download the buffer
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
    const qrFile     = path.join(sessionDir, 'qr.png');

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

    // ── Per-session message store ──────────────────────────────────────────
    // Keyed by msgId → full WebMessageInfo object
    // Stores last 500 messages per chat to cap memory usage
    const messageStore = {}; // { [chatJid]: { [msgId]: fullMsg } }
    const nameCache    = {}; // { [jid]: displayName } — persists even after msg pruned
    const MAX_PER_CHAT = 500;

    function storeMessage(msg) {
        if (!msg?.key?.id || !msg.message) return;
        const jid = msg.key.remoteJid;
        if (!messageStore[jid]) messageStore[jid] = {};
        messageStore[jid][msg.key.id] = msg;

        // Cache the sender's display name whenever we see it
        const senderJid = msg.key.participant || msg.key.remoteJid;
        if (msg.pushName && senderJid) {
            nameCache[senderJid] = msg.pushName;
        }

        // Prune oldest if over limit
        const ids = Object.keys(messageStore[jid]);
        if (ids.length > MAX_PER_CHAT) {
            delete messageStore[jid][ids[0]];
        }
    }

    function lookupMessage(chatJid, msgId) {
        return messageStore[chatJid]?.[msgId] || null;
    }

    // Get best available name for a JID
    function getName(jid, fallbackMsg) {
        return fallbackMsg?.pushName
            || fallbackMsg?.verifiedBizName
            || nameCache[jid]
            || jid?.split('@')[0]
            || 'Unknown';
    }

    sock.ev.on('creds.update', saveCreds);

    // ── Store ALL messages as they arrive ──────────────────────────────────
    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) storeMessage(msg);
    });

    let pairingCodeDone = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr && method === 'qr') {
            qrcode.toFile(qrFile, qr, { width: 400 });
            console.log(`\n[${phoneNumber}] ✅ QR saved → ${qrFile}`);
            console.log(`[${phoneNumber}] 📱 WhatsApp → Linked Devices → Scan QR\n`);
        }

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
                console.log(`[${phoneNumber}]   1. Open WhatsApp`);
                console.log(`[${phoneNumber}]   2. ⋮ → Linked Devices → Link a Device`);
                console.log(`[${phoneNumber}]   3. "Link with phone number instead"`);
                console.log(`[${phoneNumber}]   4. Enter: ${formatted}\n`);
            } catch (err) {
                console.error(`[${phoneNumber}] ❌ Pairing code failed: ${err.message}`);
                pairingCodeDone = false;
            }
        }

        if (connection === 'open') {
            console.log(`\n[${phoneNumber}] ✅ CONNECTED!`);
            console.log(`[${phoneNumber}] 📌 Anti-delete ON | Reply to view-once to save it\n`);
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === 401 || code === 440) {
                console.log(`[${phoneNumber}] 🚫 Logged out (code ${code}). Delete session and re-add.`);
            } else {
                console.log(`[${phoneNumber}] 🔄 Reconnecting in 5s...`);
                setTimeout(() => startSession(phoneNumber, 'qr'), 5000);
            }
        }
    });

    // ── Anti-delete: catch deleted messages ───────────────────────────────
    sock.ev.on('messages.update', async (updates) => {
        for (const { key, update } of updates) {
            // Check for REVOKE (deleted for everyone) or ADMIN_REVOKE (admin delete in group)
            const isDeleted = update.messageStubType === WAMessageStubType.REVOKE
                           || update.messageStubType === WAMessageStubType.ADMIN_REVOKE
                           || update.message === null;

            if (!isDeleted) continue;

            // The key.id here is the DELETED message's ID
            const deletedMsgId = key.id;
            const chatJid      = key.remoteJid;

            // Skip if WE deleted our own message
            if (key.fromMe) {
                console.log(`[${phoneNumber}] 🗑️  You deleted your own message — ignoring`);
                continue;
            }

            // Look up original message from store
            const original = lookupMessage(chatJid, deletedMsgId);

            if (!original) {
                console.log(`[${phoneNumber}] 🗑️  Delete detected but original not in store (too old or never seen)`);
                continue;
            }

            const senderJid  = original.key.participant || original.key.remoteJid;
            // getName checks pushName on the msg, then the persistent nameCache, then falls back to number
            const senderName = getName(senderJid, original);

            console.log(`\n[${phoneNumber}] 🗑️  DELETE DETECTED`);
            console.log(`[${phoneNumber}]    Chat:   ${chatJid}`);
            console.log(`[${phoneNumber}]    Sender: ${senderName} (${senderJid})`);

            // Build and send notification to owner
            const ownerJid = phoneNumber + '@s.whatsapp.net';
            const header   = `🗑️ *Deleted Message*\n👤 From: *${senderName}*\n📞 Number: ${senderJid.split('@')[0]}\n💬 Chat: ${chatJid}\n`;

            try {
                const info = await buildDeletedNotification(sock, original, senderJid, chatJid);

                if (info.kind === 'text') {
                    await sock.sendMessage(ownerJid, {
                        text: header + `\n📝 *Message:*\n${info.text}`
                    });
                    console.log(`[${phoneNumber}] ✅ Deleted text forwarded`);

                } else if (info.kind === 'media') {
                    await sock.sendMessage(ownerJid, {
                        [info.mediaKey]: info.buffer,
                        caption: header + (info.caption ? `\n📝 Caption: ${info.caption}` : '')
                    });
                    console.log(`[${phoneNumber}] ✅ Deleted media forwarded (${info.type})`);

                } else if (info.kind === 'media_failed') {
                    await sock.sendMessage(ownerJid, {
                        text: header + `\n⚠️ Media (${info.type}) could not be retrieved`
                    });
                    console.log(`[${phoneNumber}] ⚠️  Deleted media could not be downloaded`);

                } else {
                    await sock.sendMessage(ownerJid, {
                        text: header + `\n⚠️ Unknown message type: ${info.type}`
                    });
                }
            } catch (err) {
                console.error(`[${phoneNumber}] ❌ Anti-delete error: ${err.message}`);
            }
        }
    });

    // ── View-once handler ──────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message) continue;
            if (!msg.key.fromMe) continue;

            const from        = msg.key.remoteJid;
            const contextInfo = extractContextInfo(msg.message);
            if (!contextInfo?.quotedMessage) continue;

            const viewOnceContent = extractViewOnce(contextInfo.quotedMessage);
            if (!viewOnceContent) continue;

            console.log(`\n[${phoneNumber}] 🔥 View-once reply detected! Forwarding...`);

            const stanzaId    = contextInfo.stanzaId;
            const participant = contextInfo.participant;
            const storedMsg   = lookupMessage(from, stanzaId)
                             || lookupMessage(participant || from, stanzaId);

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

// ── Helpers ────────────────────────────────────────────────────────────────
function extractContextInfo(message) {
    const types = [
        'conversation', 'extendedTextMessage', 'imageMessage',
        'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage',
        'buttonsResponseMessage', 'listResponseMessage',
    ];
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
        if (!buffer || buffer.length < 500) {
            console.log(`[${phoneNumber}] ❌ View-once download failed (${buffer?.length ?? 0} bytes)`);
            return;
        }
        const type     = getContentType(msgToDownload.message);
        const ownerJid = phoneNumber + '@s.whatsapp.net';
        const mediaKey = type === 'imageMessage' ? 'image'
                       : type === 'videoMessage' ? 'video'
                       : 'audio';
        await sock.sendMessage(ownerJid, {
            [mediaKey]: buffer,
            caption: `👁️ *View Once*\n📍 From: ${from}`
        });
        console.log(`[${phoneNumber}] ✅ View-once forwarded (${(buffer.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
        console.error(`[${phoneNumber}] ❌ View-once error: ${err.message}`);
    }
}

// ── Connection method prompt ───────────────────────────────────────────────
async function askConnectionMethod(rl, phoneNumber) {
    console.log(`\nHow should ${phoneNumber} connect?`);
    console.log('  1. QR Code      — scan with camera');
    console.log('  2. Pairing Code — enter code on phone');
    const choice = (await ask(rl, 'Choose (1/2): ')).trim();
    return choice === '2' ? 'code' : 'qr';
}

// ── Main menu ──────────────────────────────────────────────────────────────
async function menu() {
    const rl = createRL();

    console.log('\n╔══════════════════════════════════╗');
    console.log('║   WhatsApp View-Once Saver Bot   ║');
    console.log('║    + Anti-Delete  | Multi-User   ║');
    console.log('╚══════════════════════════════════╝\n');

    const users = loadUsers();

    if (users.length > 0) {
        console.log(`📋 Registered users (${users.length}):`);
        users.forEach((u, i) => console.log(`   ${i + 1}. ${u.number}`));
        console.log('');
    }

    console.log('Options:');
    console.log('  1. Start all existing sessions');
    console.log('  2. Add new user + connect now');
    console.log('  3. Add new user only (connect later)');
    console.log('  4. Start a specific user session');
    console.log('  5. Delete a user session');
    console.log('');

    const choice = (await ask(rl, 'Choose (1-5): ')).trim();

    if (choice === '1') {
        rl.close();
        if (users.length === 0) { console.log('⚠️  No users found.'); return; }
        console.log(`\n🚀 Starting ${users.length} session(s)...\n`);
        for (const user of users) await startSession(user.number, 'qr');

    } else if (choice === '2') {
        const number = (await ask(rl, 'Enter WhatsApp number (e.g. 254712345678): ')).trim();
        const method = await askConnectionMethod(rl, number);
        rl.close();
        addUser(number);
        console.log(`\n🚀 Connecting ${number} via ${method === 'code' ? 'Pairing Code' : 'QR'}...\n`);
        await startSession(number, method);

    } else if (choice === '3') {
        const number = (await ask(rl, 'Enter WhatsApp number (e.g. 254712345678): ')).trim();
        rl.close();
        if (addUser(number)) console.log(`✅ User ${number} added. Run bot again to connect.`);

    } else if (choice === '4') {
        if (users.length === 0) { console.log('⚠️  No users found.'); rl.close(); return; }
        const idx  = (await ask(rl, `Pick user (1-${users.length}): `)).trim();
        const user = users[parseInt(idx) - 1];
        if (!user) { console.log('❌ Invalid'); rl.close(); return; }
        const method = await askConnectionMethod(rl, user.number);
        rl.close();
        console.log(`\n🚀 Starting ${user.number}...\n`);
        await startSession(user.number, method);

    } else if (choice === '5') {
        if (users.length === 0) { console.log('⚠️  No users found.'); rl.close(); return; }
        console.log('\nWhich user to delete?');
        users.forEach((u, i) => console.log(`  ${i + 1}. ${u.number}`));
        const idx     = (await ask(rl, `Pick user (1-${users.length}): `)).trim();
        const user    = users[parseInt(idx) - 1];
        if (!user) { console.log('❌ Invalid'); rl.close(); return; }
        const confirm = (await ask(rl, `⚠️  Delete ${user.number} and ALL their data? (yes/no): `)).trim();
        rl.close();
        if (confirm.toLowerCase() === 'yes') {
            deleteSession(user.number);
            console.log(`\n🗑️  Session for ${user.number} fully deleted.`);
        } else {
            console.log('❌ Cancelled.');
        }

    } else {
        rl.close();
        console.log('❌ Invalid choice');
    }
}

async function startAllSessions() {
    const users = loadUsers();
    if (users.length === 0) {
        console.log('⚠️  No users found.');
        return;
    }
    console.log(`\n🚀 Starting ${users.length} session(s)...\n`);
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
    console.log(`\n🚀 Connecting ${cliNumber} via ${method === 'code' ? 'Pairing Code' : 'QR'}...\n`);
    await startSession(cliNumber, method);
}

main().catch((err) => {
    console.error('❌ Startup error:', err);
    process.exit(1);
});
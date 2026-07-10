const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    downloadMediaMessage, 
    getContentType, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore 
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const readline = require('readline');

const USERS_FILE = './users.json';

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
    const sessionDir = `./sessions/${phoneNumber}`;
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

// ── Start session ──────────────────────────────────────────────────────────
async function startSession(phoneNumber, method = 'qr') {
    const sessionDir = `./sessions/${phoneNumber}`;
    const qrFile     = `./sessions/${phoneNumber}/qr.png`;

    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(`${sessionDir}/auth`);
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

    sock.ev.on('creds.update', saveCreds);

    let pairingCodeDone = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        // ── QR method ─────────────────────────────────────────────────────
        if (qr && method === 'qr') {
            qrcode.toFile(qrFile, qr, { width: 400 });
            console.log(`\n[${phoneNumber}] ✅ QR saved → ${qrFile}`);
            console.log(`[${phoneNumber}] 📱 WhatsApp → Linked Devices → Scan QR\n`);
        }

        // ── Pairing code method ────────────────────────────────────────────
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
                console.log(`[${phoneNumber}]`);
                console.log(`[${phoneNumber}] How to link:`);
                console.log(`[${phoneNumber}]   1. Open WhatsApp on your phone`);
                console.log(`[${phoneNumber}]   2. Tap ⋮  →  Linked Devices`);
                console.log(`[${phoneNumber}]   3. Tap "Link a Device"`);
                console.log(`[${phoneNumber}]   4. Tap "Link with phone number instead"`);
                console.log(`[${phoneNumber}]   5. Enter code → ${formatted}\n`);
            } catch (err) {
                console.error(`[${phoneNumber}] ❌ Pairing code failed: ${err.message}`);
                pairingCodeDone = false;
            }
        }

        if (connection === 'open') {
            console.log(`\n[${phoneNumber}] ✅ CONNECTED!`);
            console.log(`[${phoneNumber}] 📌 Reply to any view-once with any text to forward it\n`);
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === 401 || code === 440) {
                console.log(`[${phoneNumber}] 🚫 Logged out (code ${code}). Delete session and re-add to reconnect.`);
            } else {
                console.log(`[${phoneNumber}] 🔄 Connection closed (code ${code}). Reconnecting in 5s...`);
                setTimeout(() => startSession(phoneNumber, 'qr'), 5000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message) continue;
            if (!msg.key.fromMe) continue;

            const from = msg.key.remoteJid;
            const contextInfo = extractContextInfo(msg.message);
            if (!contextInfo?.quotedMessage) continue;

            const viewOnceContent = extractViewOnce(contextInfo.quotedMessage);
            if (!viewOnceContent) continue;

            console.log(`\n[${phoneNumber}] 🔥 View-once reply detected! Forwarding...`);

            const fakeMsg = {
                key: {
                    remoteJid: contextInfo.participant || from,
                    id: contextInfo.stanzaId,
                    fromMe: false,
                },
                message: viewOnceContent
            };

            await forwardToOwner(sock, fakeMsg, from, phoneNumber);
        }
    });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function extractContextInfo(message) {
    const types = [
        'conversation', 'extendedTextMessage', 'imageMessage',
        'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage',
    ];
    for (const t of types) {
        if (message[t]?.contextInfo) return message[t].contextInfo;
    }
    return null;
}

function extractViewOnce(quoted) {
    if (quoted.viewOnceMessage?.message)            return quoted.viewOnceMessage.message;
    if (quoted.viewOnceMessageV2?.message)          return quoted.viewOnceMessageV2.message;
    if (quoted.viewOnceMessageV2Extension?.message) return quoted.viewOnceMessageV2Extension.message;
    if (quoted.imageMessage || quoted.videoMessage || quoted.audioMessage) return quoted;
    return null;
}

// ── Download buffer and forward — no disk write ────────────────────────────
async function forwardToOwner(sock, fakeMsg, from, phoneNumber) {
    try {
        const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {}, { sock });

        if (!buffer || buffer.length < 500) {
            console.log(`[${phoneNumber}] ❌ Download failed (${buffer?.length ?? 0} bytes)`);
            return;
        }

        const type     = getContentType(fakeMsg.message);
        const ownerJid = phoneNumber + '@s.whatsapp.net';
        const mediaKey = type === 'imageMessage' ? 'image'
                       : type === 'videoMessage' ? 'video'
                       : 'audio';

        await sock.sendMessage(ownerJid, {
            [mediaKey]: buffer,
            caption: `👁️ *View Once*\n📍 From: ${from}`
        });

        console.log(`[${phoneNumber}] ✅ Forwarded to owner (${(buffer.length / 1024).toFixed(1)} KB — not saved to disk)`);

    } catch (err) {
        console.error(`[${phoneNumber}] ❌ Error: ${err.message}`);
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
    console.log('║       Multi-User Manager         ║');
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

async function main() {
    const cliNumber = process.argv[2];

    if (cliNumber === '--all') {
        const users = loadUsers();
        if (users.length === 0) {
            console.log('⚠️  No users found.');
            return;
        }
        console.log(`\n🚀 Starting ${users.length} session(s)...\n`);
        for (const user of users) await startSession(user.number, 'qr');
        return;
    }

    if (cliNumber) {
        console.log(`\n🚀 Connecting ${cliNumber} via QR...\n`);
        await startSession(cliNumber, 'qr');
        return;
    }

    await menu();
}

main().catch((err) => {
    console.error('❌ Startup error:', err);
    process.exit(1);
});
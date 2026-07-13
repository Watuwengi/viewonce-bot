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

// ── Inline Multi-Session Cloud Orchestrator ──────────────────────────────
async function startBotSessionInline(phoneNumber, onQrGenerated) {
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

    const messageStore = {};
    const nameCache     = {};
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

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        // Convert the raw text QR string into a base64 DataURL and send it up to server.js
        if (qr && onQrGenerated) {
            try {
                const dataUrl = await qrcode.toDataURL(qr);
                onQrGenerated(dataUrl);
            } catch (err) {
                console.error(`[${phoneNumber}] Failed to render QR string:`, err.message);
            }
        }

        if (connection === 'open') {
            console.log(`\n[${phoneNumber}] ✅ CONNECTED INLINE!`);
            console.log(`[${phoneNumber}] 📌 Anti-delete ON | Reply to view-once to save it\n`);
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === 401 || code === 440) {
                console.log(`[${phoneNumber}] 🚫 Session expired. Clean up data and re-pair.`);
            } else {
                console.log(`[${phoneNumber}] 🔄 Reconnecting inline instance in 5s...`);
                setTimeout(() => startBotSessionInline(phoneNumber, onQrGenerated), 5000);
            }
        }
    });

    // ── Anti-delete Event Handler ──────────────────────────────────────────
    sock.ev.on('messages.update', async (updates) => {
        for (const { key, update } of updates) {
            const isDeleted = update.messageStubType === WAMessageStubType.REVOKE
                           || update.messageStubType === WAMessageStubType.ADMIN_REVOKE
                           || update.message === null;

            if (!isDeleted) continue;
            if (key.fromMe) continue;

            const original = lookupMessage(key.remoteJid, key.id);
            if (!original) continue;

            const senderJid  = original.key.participant || original.key.remoteJid;
            const senderName = getName(senderJid, original);
            const ownerJid = phoneNumber + '@s.whatsapp.net';
            const header   = `🗑️ *Deleted Message*\n👤 From: *${senderName}*\n📞 Number: ${senderJid.split('@')[0]}\n💬 Chat: ${key.remoteJid}\n`;

            try {
                const info = await buildDeletedNotification(sock, original, senderJid, key.remoteJid);
                if (info.kind === 'text') {
                    await sock.sendMessage(ownerJid, { text: header + `\n📝 *Message:*\n${info.text}` });
                } else if (info.kind === 'media') {
                    await sock.sendMessage(ownerJid, { [info.mediaKey]: info.buffer, caption: header + (info.caption ? `\n📝 Caption: ${info.caption}` : '') });
                }
            } catch (err) {
                console.error(`[${phoneNumber}] Inline Anti-delete dispatch error:`, err.message);
            }
        }
    });

    // ── View-once Event Handler ─────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message || !msg.key.fromMe) continue;

            const from = msg.key.remoteJid;
            const contextInfo = extractContextInfo(msg.message);
            if (!contextInfo?.quotedMessage) continue;

            const viewOnceContent = extractViewOnce(contextInfo.quotedMessage);
            if (!viewOnceContent) continue;

            console.log(`\n[${phoneNumber}] 🔥 View-once reply detected!`);
            const stanzaId = contextInfo.stanzaId;
            const participant = contextInfo.participant;
            const storedMsg = lookupMessage(from, stanzaId) || lookupMessage(participant || from, stanzaId);

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

// ── Legacy Start Session (Fallback for CLI methods) ────────────────────────
async function startSession(phoneNumber, method = 'qr') {
    await startBotSessionInline(phoneNumber, () => {});
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
        await sock.sendMessage(ownerJid, { [mediaKey]: buffer, caption: `👁️ *View Once*\n📍 From: ${from}` });
    } catch (err) {
        console.error(`[${phoneNumber}] View-once capture failure:`, err.message);
    }
}

// Export module logic directly to support server.js unified process tree
module.exports = {
    startBotSessionInline,
    loadUsers,
    addUser,
    deleteSession
};
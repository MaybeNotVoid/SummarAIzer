require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');

const { loadConfig } = require('./src/config');
const { MessageStorage } = require('./src/storage');
const { ContactsCache } = require('./src/contactsCache');
const { GeminiService, getTotalAudioDurationSeconds } = require('./src/geminiService');
const {
    SummaryOrchestrator,
    resolveSelfChatId,
    getSelfCandidateIds
} = require('./src/summarizer');

const config = loadConfig();
const storage = new MessageStorage(config.dataDir);
const contactsCache = new ContactsCache();
const geminiService = new GeminiService(config);
const orchestrator = new SummaryOrchestrator({ config, storage, geminiService });

const BOT_HEADER_PREFIXES = [
    '☀️ *RIASSUNTO MATTUTINO',
    '🌙 *RIASSUNTO SERALE',
    '⚠️ *SummarAIzer',
    '📊 *Stato SummarAIzer*'
];

const SELF_COMMANDS = new Set([
    '!stato',
    '!status',
    '!riassunto',
    '!riassunto 24h',
    '!riassunto mattina',
    '!riassunto sera',
    '!riassunto serale'
]);

const client = new Client({
    authStrategy: new LocalAuth({ clientId: config.sessionName }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let schedulersStarted = false;
let isClientReady = false;

function isIgnoredJid(jid) {
    if (!jid) return true;
    return (
        jid === 'status@broadcast' ||
        jid.endsWith('@broadcast') ||
        jid.endsWith('@newsletter')
    );
}

function isBotMessageBody(body) {
    if (!body) return false;
    const trimmed = body.trim();
    return BOT_HEADER_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

function isSelfChatMessage(msg) {
    const selfIds = new Set(getSelfCandidateIds(client, config));
    if (selfIds.size === 0) return false;
    // In WhatsApp multi-device la self-chat ha spesso msg.from = numero@c.us e msg.to = id@lid
    if (selfIds.has(msg.from) && selfIds.has(msg.to)) return true;
    if (msg.fromMe && msg.to && String(msg.to).endsWith('@lid') && selfIds.has(msg.from)) {
        // Auto-apprende il proprio @lid dalla self-chat se non ancora valorizzato
        if (!client.selfLid && selfIds.has(msg.to)) return true;
    }
    return false;
}

function isManualCommandText(body) {
    if (!body) return false;
    return SELF_COMMANDS.has(String(body).trim().toLowerCase());
}

async function handleSelfCommand(msg) {
    const text = (msg.body || '').trim().toLowerCase();
    if (!SELF_COMMANDS.has(text)) return false;

    // Apprende automaticamente l'ID della self-chat (es. @lid) da cui l'utente ha inviato il comando
    if (msg.to && String(msg.to).endsWith('@lid') && !client.selfLid) {
        client.selfLid = msg.to;
    }
    if (msg.to) {
        client.selfChatId = msg.to;
    }

    const replyTarget = msg.to || resolveSelfChatId(client, config);
    console.log(`[Command] Ricevuto comando "${text}" (target risposta: ${replyTarget})`);

    if (text === '!stato' || text === '!status') {
        const nowMs = Date.now();
        const last24h = storage.getMessagesBetween(nowMs - 24 * 3600 * 1000, nowMs);
        const audioCount = last24h.filter(m => m.audioPath).length;
        const audioMin = Math.round((getTotalAudioDurationSeconds(last24h) / 60) * 10) / 10;
        const state = storage.getState();

        const statusMsg = [
            '📊 *Stato SummarAIzer*',
            `• Messaggi ultime 24h: *${last24h.length}*`,
            `• Vocali/Audio ultime 24h: *${audioCount}* (~${audioMin} min)`,
            `• Gruppi Lavoro configurati: *${config.workGroupIds.length}*`,
            `• Soglia Mappazzone XL: *${config.audioChunkThresholdMinutes} min* (pausa ${config.chunkCooldownSeconds}s)`,
            `• Catena modelli: _${config.modelChain.join(' → ')}_`,
            `• Cron Mattina: \`${config.morningCron}\` (${config.timezone})`,
            `• Cron Sera: \`${config.eveningCron}\` (${config.timezone})`,
            `• Ultimo mattutino: ${state.lastMorningRunAt ? new Date(state.lastMorningRunAt).toLocaleString('it-IT', { timeZone: config.timezone }) : 'mai'}`,
            `• Ultimo serale: ${state.lastEveningRunAt ? new Date(state.lastEveningRunAt).toLocaleString('it-IT', { timeZone: config.timezone }) : 'mai'}`,
            '',
            '_Comandi: `!riassunto`, `!riassunto sera`, `!stato`_'
        ].join('\n');

        await orchestrator.sendToSelf(client, statusMsg, replyTarget);
        return true;
    }

    if (text === '!riassunto' || text === '!riassunto 24h' || text === '!riassunto mattina') {
        await orchestrator.runSummary('morning', client, {
            updateState: false,
            replyToId: replyTarget
        });
        return true;
    }

    if (text === '!riassunto sera' || text === '!riassunto serale') {
        await orchestrator.runSummary('evening', client, {
            updateState: false,
            replyToId: replyTarget
        });
        return true;
    }

    return false;
}

async function ingestWhatsAppMessage(msg) {
    try {
        if (!msg || !msg.id?._serialized) return;

        const msgId = msg.id._serialized;
        if (storage.isBotSentMessage(msgId)) return;
        if (isIgnoredJid(msg.from) || isIgnoredJid(msg.to)) return;

        if (isBotMessageBody(msg.body)) {
            storage.recordBotSentMessage(msgId);
            return;
        }

        // Qualsiasi comando manuale inviato dall'utente (anche con destinatario @lid) viene eseguito subito
        if (msg.fromMe && (isManualCommandText(msg.body) || isSelfChatMessage(msg))) {
            const handled = await handleSelfCommand(msg);
            if (handled) return;
            // Ignora comunque altri messaggi scritti nella propria self-chat per non auto-riassumerli
            if (isSelfChatMessage(msg)) return;
        }

        if (msg.fromMe && !config.includeOwnMessages) return;

        const meta = contactsCache.resolveMessageMetadata(msg);
        const timestampMs =
            typeof msg.timestamp === 'number' && msg.timestamp > 0
                ? msg.timestamp * 1000
                : Date.now();

        const isAudio =
            Boolean(msg.hasMedia) &&
            (msg.type === 'ptt' || msg.type === 'audio');

        let audioInfo = {
            audioPath: null,
            audioMimeType: null,
            audioDurationSec: 0
        };

        if (isAudio) {
            try {
                const media = await msg.downloadMedia();
                if (media && media.data) {
                    audioInfo = storage.saveAudioMedia(
                        msgId,
                        media.data,
                        media.mimetype,
                        msg.duration
                    );
                }
            } catch (mediaErr) {
                console.error(
                    `[WhatsApp] Impossibile scaricare audio ${msgId} da ${meta.chatName}:`,
                    mediaErr.message
                );
            }
        }

        const body = (msg.body || '').trim();
        if (!body && !audioInfo.audioPath) return;

        storage.appendMessage({
            id: msgId,
            timestamp: timestampMs,
            chatId: meta.chatId,
            chatName: meta.chatName,
            isGroup: meta.isGroup,
            senderId: meta.senderId,
            senderName: meta.senderName,
            fromMe: meta.fromMe,
            type: msg.type || 'chat',
            body,
            ...audioInfo
        });
    } catch (err) {
        console.error('[Message Ingest Error]', err.message);
    }
}

function startSchedulers() {
    if (schedulersStarted) return;
    schedulersStarted = true;

    cron.schedule(
        config.morningCron,
        async () => {
            console.log('[Cron] Trigger riassunto mattutino...');
            try {
                await orchestrator.runSummary('morning', client);
            } catch (err) {
                console.error('[Cron Morning Error]', err.message);
            }
        },
        { timezone: config.timezone }
    );

    cron.schedule(
        config.eveningCron,
        async () => {
            console.log('[Cron] Trigger riassunto serale...');
            try {
                await orchestrator.runSummary('evening', client);
            } catch (err) {
                console.error('[Cron Evening Error]', err.message);
            }
        },
        { timezone: config.timezone }
    );

    cron.schedule(
        '0 4 * * *',
        () => {
            const res = storage.cleanupOldData(config.retentionHours);
            console.log(
                `[Cleanup] Completato: ${res.keptMessages} messaggi mantenuti, ${res.deletedAudioCount} file audio rimossi.`
            );
        },
        { timezone: config.timezone }
    );

    setInterval(() => {
        contactsCache.refreshFromClient(client).catch(() => {});
    }, 6 * 3600 * 1000);

    console.log(
        `⏰ Scheduler attivi (${config.timezone}): Mattina "${config.morningCron}" | Sera "${config.eveningCron}"`
    );
}

client.on('qr', qr => {
    console.log('[WhatsApp] Scansiona il codice QR con il tuo telefono:');
    qrcode.generate(qr, { small: true });
});

client.on('loading_screen', (percent, message) => {
    // Ignora gli eventi loading_screen tardivi (es. 99%) se il client è già diventato ready
    if (isClientReady) return;
    if (Number(percent) >= 99) {
        console.log(
            `[WhatsApp] Caricamento: ${percent}% - ${message} (sincronizzazione quasi pronta...)`
        );
    } else {
        console.log(`[WhatsApp] Caricamento: ${percent}% - ${message}`);
    }
});

client.on('authenticated', () => {
    console.log('✅ [WhatsApp] Autenticazione riuscita!');
});

client.on('auth_failure', msg => {
    console.error('❌ [WhatsApp] Autenticazione fallita:', msg);
});

client.on('disconnected', reason => {
    isClientReady = false;
    console.warn('⚠️ [WhatsApp] Disconnesso:', reason);
});

client.on('ready', async () => {
    isClientReady = true;
    await contactsCache.refreshFromClient(client).catch(err => {
        console.warn('[ContactsCache] Primo refresh fallito:', err.message);
    });

    const selfIds = getSelfCandidateIds(client, config);
    console.log('============================================================');
    console.log('✅ SummarAIzer WhatsApp companion PRONTO e IN ASCOLTO (100%)!');
    console.log(`👤 Destinatario riassunti (Self-Chat): ${selfIds.join(' / ')}`);
    console.log(`💼 Gruppi lavoro configurati: ${config.workGroupIds.length}`);
    console.log(`🤖 Catena modelli Gemini: ${config.modelChain.join(' -> ')}`);
    console.log('💬 Scrivi !stato o !riassunto nella tua chat personale per testare.');
    console.log('============================================================');

    startSchedulers();
});

client.on('message_create', ingestWhatsAppMessage);

process.on('unhandledRejection', reason => {
    console.error('[Unhandled Rejection]', reason);
});

process.on('uncaughtException', err => {
    console.error('[Uncaught Exception]', err);
});

console.log('🚀 Avvio SummarAIzer...');
client.initialize();

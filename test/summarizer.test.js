const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../src/config');
const {
    MessageStorage,
    normalizeAudioMimeType,
    estimateAudioDurationSec
} = require('../src/storage');
const { classifyMessageHint } = require('../src/categorizer');
const {
    GeminiService,
    splitMessagesIntoChunks,
    buildTranscriptAndAudioList
} = require('../src/geminiService');
const { SummaryOrchestrator, splitForWhatsApp } = require('../src/summarizer');

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'summaraizer-test-'));
}

test('categorizer riconosce gruppi team software e contatti di lavoro senza falsi positivi', () => {
    const config = loadConfig({
        WORK_CONTACT_KEYWORDS: 'ACME,CORP',
        WORK_GROUP_IDS: '120363999@g.us',
        WORK_GROUP_KEYWORDS: 'software,team,dev'
    });

    assert.equal(
        classifyMessageHint({ chatId: '120363999@g.us', chatName: 'Generale', isGroup: true, senderName: 'Paolo' }, config),
        'WORK_HINT'
    );
    assert.equal(
        classifyMessageHint({ chatId: '120363111@g.us', chatName: 'Team Software', isGroup: true, senderName: 'Anna' }, config),
        'WORK_HINT'
    );
    assert.equal(
        classifyMessageHint({ chatId: '39111@c.us', chatName: 'Marco ACME', isGroup: false, senderName: 'Marco ACME' }, config),
        'WORK_HINT'
    );
    assert.equal(
        classifyMessageHint({ chatId: '39222@c.us', chatName: 'CORP-Luca', isGroup: false, senderName: 'CORP-Luca' }, config),
        'WORK_HINT'
    );
    // "Corpo" contiene "corp" ma NON deve fare match su wordBoundary
    assert.equal(
        classifyMessageHint({ chatId: '39333@c.us', chatName: 'Corpo Libero', isGroup: false, senderName: 'Corpo Libero' }, config),
        'AUTO'
    );
    assert.equal(
        classifyMessageHint({ chatId: '39444@c.us', chatName: 'Mamma', isGroup: false, senderName: 'Mamma' }, config),
        'AUTO'
    );
});

test('storage normalizza MIME audio, deduplica messaggi ed esclude i riassunti del bot', () => {
    const tmpDir = createTempDir();
    try {
        assert.equal(normalizeAudioMimeType('audio/ogg; codecs=opus'), 'audio/ogg');
        assert.equal(normalizeAudioMimeType('AUDIO/MPEG'), 'audio/mpeg');
        assert.equal(estimateAudioDurationSec(Buffer.alloc(5000), 'audio/ogg', 18), 18);

        const storage = new MessageStorage(tmpDir);
        const now = Date.now();

        storage.recordBotSentMessage('bot_msg_1');
        assert.equal(storage.appendMessage({ id: 'bot_msg_1', timestamp: now, body: 'riassunto' }), false);

        assert.equal(storage.appendMessage({ id: 'm1', timestamp: now - 30 * 3600 * 1000, body: 'troppo vecchio' }), true);
        assert.equal(storage.appendMessage({ id: 'm2', timestamp: now - 2 * 3600 * 1000, body: 'recente' }), true);
        // Duplicato
        assert.equal(storage.appendMessage({ id: 'm2', timestamp: now - 2 * 3600 * 1000, body: 'recente' }), false);

        const last24h = storage.getMessagesBetween(now - 24 * 3600 * 1000, now);
        assert.equal(last24h.length, 1);
        assert.equal(last24h[0].id, 'm2');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('GeminiService: sotto soglia 60 min fa 1 chiamata con File API e pulisce i file', async () => {
    const tmpDir = createTempDir();
    try {
        const audioFile = path.join(tmpDir, 'note1.ogg');
        fs.writeFileSync(audioFile, Buffer.from('fake-ogg-bytes'));

        const uploaded = [];
        const deleted = [];
        const generateCalls = [];

        const mockAi = {
            files: {
                upload: async ({ file, config }) => {
                    uploaded.push({ file, mimeType: config.mimeType });
                    return {
                        name: `files/${uploaded.length}`,
                        uri: `https://generativelanguage.googleapis.com/v1beta/files/${uploaded.length}`,
                        mimeType: config.mimeType,
                        state: 'ACTIVE'
                    };
                },
                delete: async ({ name }) => {
                    deleted.push(name);
                }
            },
            models: {
                generateContent: async req => {
                    generateCalls.push(req);
                    return { text: '☀️ *RIASSUNTO MATTUTINO*\nTutto ok.' };
                }
            }
        };

        const config = loadConfig({
            GEMINI_API_KEY: 'test-key',
            WORK_CONTACT_KEYWORDS: 'ACME,CORP',
            AUDIO_CHUNK_THRESHOLD_MINUTES: '60',
            CHUNK_COOLDOWN_SECONDS: '65'
        });

        const sleeps = [];
        const service = new GeminiService(config, {
            aiClient: mockAi,
            sleepFn: async ms => sleeps.push(ms)
        });

        const now = Date.now();
        const messages = [
            {
                id: '1',
                timestamp: now - 3600 * 1000,
                chatId: '39111@c.us',
                chatName: 'Marco ACME',
                isGroup: false,
                senderName: 'Marco ACME',
                fromMe: false,
                type: 'ptt',
                body: '',
                audioPath: audioFile,
                audioMimeType: 'audio/ogg',
                audioDurationSec: 1200 // 20 min
            },
            {
                id: '2',
                timestamp: now - 1800 * 1000,
                chatId: '39111@c.us',
                chatName: 'Marco ACME',
                isGroup: false,
                senderName: 'IO',
                fromMe: true,
                type: 'chat',
                body: 'Sistemato il bug sul server, tutto ok!'
            }
        ];

        const { transcript } = buildTranscriptAndAudioList(messages, config);
        assert.match(transcript, /\[IO\]: Sistemato il bug sul server/);
        assert.match(transcript, /\[HINT: LAVORO\]/);

        const result = await service.summarizeMessages(messages, {
            mode: 'morning',
            dateLabel: 'ven 20/11/2026'
        });

        assert.equal(result.chunked, false);
        assert.equal(result.modelUsed, 'gemini-3.8-flash');
        assert.equal(uploaded.length, 1);
        assert.equal(deleted.length, 1);
        assert.equal(generateCalls.length, 1);
        assert.equal(sleeps.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('GeminiService: Mappazzone XL (>60 min) divide in 2 blocchi, attende 65s e fa merge finale', async () => {
    const tmpDir = createTempDir();
    try {
        const audio1 = path.join(tmpDir, 'a1.ogg');
        const audio2 = path.join(tmpDir, 'a2.ogg');
        fs.writeFileSync(audio1, Buffer.from('a1'));
        fs.writeFileSync(audio2, Buffer.from('a2'));

        const deleted = [];
        const generateCalls = [];
        const sleeps = [];

        const mockAi = {
            files: {
                upload: async ({ config }) => ({
                    name: `files/${Math.random().toString(36).slice(2)}`,
                    uri: 'https://example.com/file',
                    mimeType: config.mimeType,
                    state: 'ACTIVE'
                }),
                delete: async ({ name }) => deleted.push(name)
            },
            models: {
                generateContent: async req => {
                    generateCalls.push(req);
                    return { text: `Risposta #${generateCalls.length}` };
                }
            }
        };

        const config = loadConfig({
            GEMINI_API_KEY: 'test-key',
            AUDIO_CHUNK_THRESHOLD_MINUTES: '60',
            CHUNK_COOLDOWN_SECONDS: '65'
        });

        const service = new GeminiService(config, {
            aiClient: mockAi,
            sleepFn: async ms => sleeps.push(ms)
        });

        const base = Date.now() - 10 * 3600 * 1000;
        const messages = [
            {
                id: 'a1',
                timestamp: base,
                chatId: 'g1@g.us',
                chatName: 'Team Software',
                isGroup: true,
                senderName: 'Luca CORP',
                fromMe: false,
                type: 'ptt',
                body: '',
                audioPath: audio1,
                audioMimeType: 'audio/ogg',
                audioDurationSec: 2400 // 40 min
            },
            {
                id: 'a2',
                timestamp: base + 5 * 3600 * 1000,
                chatId: 'g1@g.us',
                chatName: 'Team Software',
                isGroup: true,
                senderName: 'Sara ACME',
                fromMe: false,
                type: 'ptt',
                body: '',
                audioPath: audio2,
                audioMimeType: 'audio/ogg',
                audioDurationSec: 2400 // 40 min -> totale 80 min > 60 min
            }
        ];

        const chunks = splitMessagesIntoChunks(messages, 60);
        assert.equal(chunks.length, 2);

        const res = await service.summarizeMessages(messages, {
            mode: 'morning',
            dateLabel: 'ven 20/11/2026'
        });

        assert.equal(res.chunked, true);
        assert.equal(res.chunksCount, 2);
        assert.equal(generateCalls.length, 3);
        assert.deepEqual(sleeps, [65000]);
        assert.equal(deleted.length, 2);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('GeminiService: fallback immediato 3.8-flash -> 4-hydrogen -> 3.5-flash-lite', async () => {
    const triedModels = [];
    const mockAi = {
        files: { upload: async () => {}, delete: async () => {} },
        models: {
            generateContent: async ({ model }) => {
                triedModels.push(model);
                if (model === 'gemini-3.8-flash') throw new Error('429 Quota exceeded');
                if (model === 'gemini-4-hydrogen') throw new Error('503 Unavailable');
                return { text: 'Fallback riuscito su flash-lite!' };
            }
        }
    };

    const config = loadConfig({ GEMINI_API_KEY: 'test-key' });
    const service = new GeminiService(config, { aiClient: mockAi });

    const res = await service.generateWithFallback({
        systemInstruction: 'test',
        contents: ['ciao']
    });

    assert.deepEqual(triedModels, [
        'gemini-3.8-flash',
        'gemini-4-hydrogen',
        'gemini-3.5-flash-lite'
    ]);
    assert.equal(res.modelUsed, 'gemini-3.5-flash-lite');
    assert.equal(res.text, 'Fallback riuscito su flash-lite!');
});

test('SummaryOrchestrator: finestra serale legge solo aggiunte dopo il mattino e registra bot msg', async () => {
    const tmpDir = createTempDir();
    try {
        const config = loadConfig({ GEMINI_API_KEY: 'test-key', DATA_DIR: tmpDir });
        const storage = new MessageStorage(tmpDir);

        const morningTime = new Date('2026-11-20T08:15:00+01:00').getTime();
        const eveningTime = new Date('2026-11-20T22:00:00+01:00').getTime();

        storage.setLastMorningRunAt(morningTime);
        storage.appendMessage({
            id: 'before_morning',
            timestamp: morningTime - 60000,
            chatId: '39111@c.us',
            chatName: 'Marco ACME',
            isGroup: false,
            senderName: 'Marco ACME',
            fromMe: false,
            type: 'chat',
            body: 'Messaggio vecchio di prima delle 08:15'
        });
        storage.appendMessage({
            id: 'after_morning',
            timestamp: morningTime + 3 * 3600 * 1000,
            chatId: '39111@c.us',
            chatName: 'Marco ACME',
            isGroup: false,
            senderName: 'Marco ACME',
            fromMe: false,
            type: 'chat',
            body: 'Aggiornamento pomeridiano'
        });

        let receivedMessages = [];
        const fakeGemini = {
            summarizeMessages: async msgs => {
                receivedMessages = msgs;
                return {
                    text: '🌙 *RIASSUNTO SERALE*\nOk',
                    modelUsed: 'gemini-3.8-flash',
                    chunked: false,
                    chunksCount: 1,
                    audioCount: 0,
                    totalAudioMin: 0
                };
            }
        };

        const sentPayloads = [];
        const fakeClient = {
            info: { wid: { _serialized: '393330000000@c.us' } },
            sendMessage: async (to, text) => {
                sentPayloads.push({ to, text });
                return { id: { _serialized: `bot_sent_${sentPayloads.length}` } };
            }
        };

        const orchestrator = new SummaryOrchestrator({
            config,
            storage,
            geminiService: fakeGemini
        });

        const res = await orchestrator.runSummary('evening', fakeClient, { nowMs: eveningTime });
        assert.equal(res.messageCount, 1);
        assert.equal(receivedMessages.length, 1);
        assert.equal(receivedMessages[0].id, 'after_morning');
        assert.equal(sentPayloads.length, 1);
        assert.equal(sentPayloads[0].to, '393330000000@c.us');
        assert.equal(storage.isBotSentMessage('bot_sent_1'), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('splitForWhatsApp divide correttamente testi molto lunghi sulle interruzioni di riga', () => {
    const longText = Array.from({ length: 120 }, (_, i) => `Riga numero ${i + 1} con dettagli tecnici`).join('\n');
    const parts = splitForWhatsApp(longText, 500);
    assert.ok(parts.length > 1);
    for (const part of parts) {
        assert.ok(part.length <= 500);
    }
    assert.equal(parts.join('\n'), longText);
});

test('sendToSelf gestisce il fallback automatico tra @c.us (null) e @lid nella self-chat', async () => {
    const tmpDir = createTempDir();
    try {
        const config = loadConfig({ GEMINI_API_KEY: 'test-key', DATA_DIR: tmpDir });
        const storage = new MessageStorage(tmpDir);
        const orchestrator = new SummaryOrchestrator({
            config,
            storage,
            geminiService: {}
        });

        const triedTargets = [];
        const fakeClient = {
            info: { wid: { _serialized: '393330000000@c.us' } },
            selfLid: '100000000000000@lid',
            sendMessage: async (to, text, opts) => {
                triedTargets.push({ to, opts });
                if (to === '393330000000@c.us') return null;
                return { id: { _serialized: 'sent_on_lid_1' } };
            }
        };

        const sentIds = await orchestrator.sendToSelf(fakeClient, 'Test Stato');
        assert.deepEqual(sentIds, ['sent_on_lid_1']);
        assert.equal(triedTargets.length, 2);
        assert.equal(triedTargets[0].to, '393330000000@c.us');
        assert.equal(triedTargets[1].to, '100000000000000@lid');
        assert.equal(triedTargets[1].opts.sendSeen, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

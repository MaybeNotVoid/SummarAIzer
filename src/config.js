const path = require('path');

function parseCsv(value, fallback = []) {
    if (!value || !String(value).trim()) return fallback;
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function parseBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return ['1', 'true', 'yes', 'si', 'sì'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadConfig(env = process.env) {
    const primary = (env.GEMINI_MODEL_PRIMARY || 'gemini-3.8-flash').trim();
    const fallback1 = (env.GEMINI_MODEL_FALLBACK_1 || 'gemini-4-hydrogen').trim();
    const fallback2 = (env.GEMINI_MODEL_FALLBACK_2 || 'gemini-3.5-flash-lite').trim();

    const modelChain = [primary, fallback1, fallback2].filter(
        (m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx
    );

    return {
        sessionName: (env.WHATSAPP_SESSION_NAME || 'summaraizer-session').trim(),
        targetSelfId: (env.TARGET_SELF_ID || '').trim(),
        geminiApiKey: (env.GEMINI_API_KEY || '').trim(),
        modelChain,
        timezone: (env.TIMEZONE || 'Europe/Rome').trim(),
        morningCron: (env.MORNING_CRON || '15 8 * * *').trim(),
        eveningCron: (env.EVENING_CRON || '0 22 * * *').trim(),
        sendEmptySummary: parseBool(env.SEND_EMPTY_SUMMARY, true),
        audioChunkThresholdMinutes: parseNumber(env.AUDIO_CHUNK_THRESHOLD_MINUTES, 60),
        chunkCooldownSeconds: parseNumber(env.CHUNK_COOLDOWN_SECONDS, 65),
        userRoleDescription: (
            env.USER_ROLE_DESCRIPTION ||
            'sviluppatore software (progetti tecnici, ticket, deploy, bug, riunioni, clienti)'
        ).trim(),
        workContactKeywords: parseCsv(env.WORK_CONTACT_KEYWORDS, []),
        workGroupIds: parseCsv(env.WORK_GROUP_IDS, []),
        workGroupKeywords: parseCsv(env.WORK_GROUP_KEYWORDS, [
            'software',
            'team',
            'dev',
            'lavoro',
            'work'
        ]),
        includeOwnMessages: parseBool(env.INCLUDE_OWN_MESSAGES, true),
        retentionHours: parseNumber(env.RETENTION_HOURS, 72),
        dataDir: env.DATA_DIR
            ? path.resolve(env.DATA_DIR)
            : path.join(__dirname, '..', 'data')
    };
}

module.exports = {
    loadConfig,
    parseCsv,
    parseBool,
    parseNumber
};

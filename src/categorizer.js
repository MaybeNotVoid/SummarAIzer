function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesKeyword(text, keywords, { wordBoundary = false } = {}) {
    if (!text || !Array.isArray(keywords) || keywords.length === 0) return false;
    const normalized = String(text);

    for (const kw of keywords) {
        const clean = String(kw || '').trim();
        if (!clean) continue;

        if (wordBoundary) {
            // Match parola intera o separata da simboli/underscore/trattini (es. "ACME", "Marco_ACME", "CORP-Luca")
            const re = new RegExp(`(^|[^a-zA-Z0-9])${escapeRegex(clean)}([^a-zA-Z0-9]|$)`, 'i');
            if (re.test(normalized)) return true;
        } else {
            if (normalized.toLowerCase().includes(clean.toLowerCase())) return true;
        }
    }
    return false;
}

/**
 * Classifica un hint preliminare per aiutare Gemini nella separazione Lavoro / Vita Privata.
 * - WORK_HINT: gruppo esplicito di lavoro, nome gruppo con keyword lavoro, oppure contatto salvato con tag aziendale.
 * - AUTO: Gemini valuta semanticamente se la chat/audio riguarda l'attività lavorativa dell'utente.
 */
function classifyMessageHint(record, config) {
    if (!record || !config) return 'AUTO';

    if (config.workGroupIds && config.workGroupIds.includes(record.chatId)) {
        return 'WORK_HINT';
    }

    if (record.isGroup && matchesKeyword(record.chatName, config.workGroupKeywords, { wordBoundary: false })) {
        return 'WORK_HINT';
    }

    if (matchesKeyword(record.senderName, config.workContactKeywords, { wordBoundary: true })) {
        return 'WORK_HINT';
    }

    if (!record.isGroup && matchesKeyword(record.chatName, config.workContactKeywords, { wordBoundary: true })) {
        return 'WORK_HINT';
    }

    return 'AUTO';
}

module.exports = {
    classifyMessageHint,
    matchesKeyword
};

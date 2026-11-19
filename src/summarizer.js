function splitForWhatsApp(text, maxLength = 3900) {
    if (!text) return [];
    const trimmed = String(text).trim();
    if (trimmed.length <= maxLength) return [trimmed];

    const parts = [];
    const lines = trimmed.split('\n');
    let current = '';

    for (const line of lines) {
        if (line.length > maxLength) {
            if (current) {
                parts.push(current.trim());
                current = '';
            }
            for (let i = 0; i < line.length; i += maxLength) {
                parts.push(line.slice(i, i + maxLength));
            }
            continue;
        }

        const candidate = current ? `${current}\n${line}` : line;
        if (candidate.length > maxLength) {
            parts.push(current.trim());
            current = line;
        } else {
            current = candidate;
        }
    }

    if (current.trim()) {
        parts.push(current.trim());
    }

    return parts;
}

function formatDateLabel(timestampMs, timezone = 'Europe/Rome') {
    try {
        return new Intl.DateTimeFormat('it-IT', {
            timeZone: timezone,
            weekday: 'short',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        }).format(new Date(timestampMs));
    } catch {
        return new Date(timestampMs).toISOString().slice(0, 10);
    }
}

function formatTimeLabel(timestampMs, timezone = 'Europe/Rome') {
    try {
        return new Intl.DateTimeFormat('it-IT', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit'
        }).format(new Date(timestampMs));
    } catch {
        return new Date(timestampMs).toISOString().slice(11, 16);
    }
}

function getDefaultMorningAnchorMs(nowMs) {
    return nowMs - 14 * 3600 * 1000;
}

function getSelfCandidateIds(client, config) {
    const ids = [
        config?.targetSelfId,
        client?.selfChatId,
        client?.info?.wid?._serialized,
        client?.selfWid,
        client?.selfLid
    ].filter(Boolean);
    return [...new Set(ids)];
}

function resolveSelfChatId(client, config) {
    const candidates = getSelfCandidateIds(client, config);
    return candidates[0] || '';
}

class SummaryOrchestrator {
    constructor({ config, storage, geminiService }) {
        this.config = config;
        this.storage = storage;
        this.geminiService = geminiService;
        this.isRunning = false;
    }

    computeWindow(mode, nowMs = Date.now()) {
        if (mode === 'evening') {
            const state = this.storage.getState();
            const hasValidMorningRun =
                typeof state.lastMorningRunAt === 'number' &&
                state.lastMorningRunAt < nowMs &&
                nowMs - state.lastMorningRunAt <= 24 * 3600 * 1000;

            const startMs = hasValidMorningRun
                ? state.lastMorningRunAt
                : getDefaultMorningAnchorMs(nowMs);

            return { startMs, endMs: nowMs };
        }

        return {
            startMs: nowMs - 24 * 3600 * 1000,
            endMs: nowMs
        };
    }

    async sendToSelf(client, text, preferredTargetId = '') {
        const candidates = [
            preferredTargetId,
            ...getSelfCandidateIds(client, this.config)
        ].filter((id, idx, arr) => Boolean(id) && arr.indexOf(id) === idx);

        if (candidates.length === 0) {
            throw new Error(
                'Impossibile determinare il proprio ID WhatsApp (TARGET_SELF_ID o client.info.wid).'
            );
        }

        const chunks = splitForWhatsApp(text);
        const sentIds = [];

        for (const chunk of chunks) {
            let sent = null;
            let lastErr = null;

            for (const targetId of candidates) {
                try {
                    sent = await client.sendMessage(targetId, chunk, { sendSeen: false });
                    if (sent) break;
                    console.warn(
                        `[Summarizer] Chat non trovata per ${targetId} (sendMessage ha restituito null), provo ID alternativo...`
                    );
                } catch (err) {
                    lastErr = err;
                    console.warn(
                        `[Summarizer] Tentativo invio a ${targetId} fallito (${err.message}), provo ID alternativo...`
                    );
                }
            }

            if (!sent && lastErr) {
                throw lastErr;
            }

            const sentId = sent?.id?._serialized;
            if (sentId) {
                this.storage.recordBotSentMessage(sentId);
                sentIds.push(sentId);
            }
        }

        return sentIds;
    }

    async runSummary(mode, client, { nowMs = Date.now(), updateState = true, replyToId = '' } = {}) {
        if (this.isRunning) {
            console.warn(`[Summarizer] Un riassunto è già in esecuzione, salto richiesta (${mode}).`);
            return { skipped: true, reason: 'already_running' };
        }

        this.isRunning = true;
        try {
            const { startMs, endMs } = this.computeWindow(mode, nowMs);
            const messages = this.storage.getMessagesBetween(startMs, endMs);
            const dateLabel = formatDateLabel(nowMs, this.config.timezone);
            const sinceLabel = formatTimeLabel(startMs, this.config.timezone);

            console.log(
                `[Summarizer] Avvio riassunto ${mode} | Finestra: ${new Date(startMs).toISOString()} -> ${new Date(endMs).toISOString()} | Messaggi: ${messages.length}`
            );

            if (messages.length === 0) {
                if (this.config.sendEmptySummary) {
                    const emptyMsg =
                        mode === 'evening'
                            ? `🌙 *RIASSUNTO SERALE — ${dateLabel}*\n_(Aggiunte dalle ${sinceLabel})_\n\nNessun nuovo messaggio o vocale ricevuto da stamattina.`
                            : `☀️ *RIASSUNTO MATTUTINO — ${dateLabel}*\n_(Ultime 24 ore)_\n\nNessun messaggio o vocale registrato nelle ultime 24 ore.`;
                    await this.sendToSelf(client, emptyMsg, replyToId);
                }

                if (updateState) {
                    if (mode === 'morning') this.storage.setLastMorningRunAt(nowMs);
                    if (mode === 'evening') this.storage.setLastEveningRunAt(nowMs);
                }

                return { skipped: false, empty: true, messageCount: 0 };
            }

            const result = await this.geminiService.summarizeMessages(messages, {
                mode,
                dateLabel,
                sinceLabel
            });

            const footerMeta = [
                `Modello: ${result.modelUsed}`,
                `Msg: ${messages.length}`,
                result.audioCount ? `Audio: ${result.audioCount} (~${result.totalAudioMin} min)` : null,
                result.chunked ? `Mappazzone XL (${result.chunksCount} blocchi)` : null
            ]
                .filter(Boolean)
                .join(' • ');

            const finalMessage = `${result.text}\n\n_${footerMeta}_`;
            await this.sendToSelf(client, finalMessage, replyToId);

            if (updateState) {
                if (mode === 'morning') this.storage.setLastMorningRunAt(nowMs);
                if (mode === 'evening') this.storage.setLastEveningRunAt(nowMs);
            }

            console.log(`[Summarizer] Riassunto ${mode} inviato con successo (${footerMeta}).`);
            return {
                skipped: false,
                empty: false,
                messageCount: messages.length,
                modelUsed: result.modelUsed,
                chunked: result.chunked
            };
        } catch (err) {
            console.error(`[Summarizer] Errore critico durante riassunto ${mode}:`, err.message);
            try {
                await this.sendToSelf(
                    client,
                    `⚠️ *SummarAIzer — Errore Riassunto (${mode})*\n\nImpossibile generare il riassunto automatico:\n_${err.message}_`,
                    replyToId
                );
            } catch (notifyErr) {
                console.error('[Summarizer] Impossibile inviare notifica di errore:', notifyErr.message);
            }
            throw err;
        } finally {
            this.isRunning = false;
        }
    }
}

module.exports = {
    SummaryOrchestrator,
    splitForWhatsApp,
    resolveSelfChatId,
    getSelfCandidateIds
};

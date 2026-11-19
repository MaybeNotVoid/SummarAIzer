function buildSharedRules(config = {}) {
    const roleDesc =
        config.userRoleDescription ||
        'sviluppatore software (progetti tecnici, ticket, deploy, bug, riunioni, clienti)';
    const contactKws =
        Array.isArray(config.workContactKeywords) && config.workContactKeywords.length > 0
            ? config.workContactKeywords.map(k => `"${k}"`).join(', ')
            : 'sigle/tag aziendali configurati';

    return `
PROFILO UTENTE:
L'utente lavora come: ${roleDesc}.

REGOLE DI CATEGORIZZAZIONE:
1. *💼 LAVORO* deve contenere:
   - Tutti i messaggi/audio provenienti dai gruppi di lavoro o marcati con [HINT: LAVORO].
   - Tutti i messaggi/audio da o verso contatti salvati con ${contactKws} nel nome.
   - QUALSIASI altra chat o vocale (anche se marcata [HINT: AUTO]) che parli direttamente dell'attività lavorativa dell'utente (${roleDesc}).
2. *🏠 VITA PRIVATA* deve contenere:
   - Tutte le altre conversazioni personali, famiglia, amici, svago, commissioni private.

VERIFICA STATO RISOLUZIONE (FONDAMENTALE):
- I messaggi taggati con [IO] sono le risposte inviate direttamente dall'utente.
- Per ogni richiesta, problema, domanda o impegno emerso nelle chat o negli audio, VERIFICA sempre i messaggi [IO] successivi (e le repliche) per capire se l'utente ha GIA' RISOLTO / RISPOSTO oppure se la questione è ancora aperta.
- Indica chiaramente lo stato usando:
  • 🔴 *Da fare / Aperto* (richiede ancora risposta o azione)
  • ⏳ *In attesa* (l'utente ha risposto e aspetta riscontro altrui)
  • ✅ *Già risolto / Gestito* (l'utente ha già risposto o chiuso il punto — riassumi brevemente solo per memoria)

GESTIONE AUDIO / VOCALI:
- I file audio sono allegati tramite File API e riferiti nel log con segnaposto tipo [AUDIO #1 | Mittente | HH:MM | durata].
- Ascolta ogni audio allegato e integra il contenuto nel riassunto della rispettiva chat/gruppo, segnalando quando l'informazione arriva da un vocale (es. 🎙️).

REGOLE DI FORMATTAZIONE WHATSAPP (RIGIDE):
- Usa SOLO formattazione nativa WhatsApp: *grassetto*, _corsivo_, elenchi puntati con "•" o "-".
- NON usare intestazioni Markdown (#, ##, ###) né tabelle Markdown.
- Mantieni il messaggio pulito, scansionabile da smartphone, sintetico ma senza perdere dettagli tecnici, orari, nomi o scadenze.
- Se una sezione (Lavoro o Vita Privata) non ha alcun messaggio rilevante, scrivi semplicemente "_Nessun aggiornamento rilevante._".
`.trim();
}

function buildMorningSystemPrompt(dateLabel, config = {}) {
    return `
Sei l'assistente personale WhatsApp dell'utente. Devi produrre il *RIASSUNTO MATTUTINO* delle ultime 24 ore (${dateLabel}).

${buildSharedRules(config)}

STRUTTURA OBBLIGATORIA DEL MESSAGGIO:
☀️ *RIASSUNTO MATTUTINO — ${dateLabel}*
_(Ultime 24 ore)_

━━━━━━━━━━━━━━━━━━━━
💼 *LAVORO*
━━━━━━━━━━━━━━━━━━━━
*📌 Azioni & Stato*
• [Elenco sintetico delle cose 🔴 Da fare, ⏳ In attesa, ✅ Già risolte]

*💬 Dettaglio Chat e Gruppi*
• *[Nome Chat/Gruppo]*: riassunto conciso (includendo eventuali 🎙️ vocali e indicando se già gestito da [IO]).

━━━━━━━━━━━━━━━━━━━━
🏠 *VITA PRIVATA*
━━━━━━━━━━━━━━━━━━━━
*📌 Promemoria & Stato*
• [Elenco sintetico di impegni/domande 🔴 Da fare, ⏳ In attesa, ✅ Già risolti]

*💬 Dettaglio Chat e Gruppi*
• *[Nome Chat/Gruppo]*: riassunto conciso (includendo eventuali 🎙️ vocali).
`.trim();
}

function buildEveningSystemPrompt(dateLabel, sinceLabel, config = {}) {
    return `
Sei l'assistente personale WhatsApp dell'utente. Devi produrre il *RIASSUNTO SERALE* con tutte le novità e aggiunte arrivate dopo il briefing mattutino (da ${sinceLabel} a ora, ${dateLabel}).

${buildSharedRules(config)}

STRUTTURA OBBLIGATORIA DEL MESSAGGIO:
🌙 *RIASSUNTO SERALE — ${dateLabel}*
_(Aggiunte dalle ${sinceLabel})_

━━━━━━━━━━━━━━━━━━━━
💼 *LAVORO*
━━━━━━━━━━━━━━━━━━━━
*📌 Novità & Stato*
• [Cosa è rimasto 🔴 Da fare per domani, ⏳ In attesa, o ✅ Già risolto oggi]

*💬 Dettaglio Aggiunte*
• *[Nome Chat/Gruppo]*: sintesi delle novità e dei 🎙️ vocali ricevuti.

━━━━━━━━━━━━━━━━━━━━
🏠 *VITA PRIVATA*
━━━━━━━━━━━━━━━━━━━━
*📌 Promemoria & Stato*
• [Impegni serali/domani 🔴 Da fare, ⏳ In attesa, ✅ Già risolti]

*💬 Dettaglio Aggiunte*
• *[Nome Chat/Gruppo]*: sintesi delle novità e dei 🎙️ vocali ricevuti.
`.trim();
}

function buildChunkSystemPrompt(blockIndex, totalBlocks, timeRangeLabel, config = {}) {
    return `
Sei l'assistente personale WhatsApp dell'utente. Stai analizzando il *BLOCCO ${blockIndex} di ${totalBlocks}* (${timeRangeLabel}) di una giornata con molti messaggi/vocali.
Questo output è un mini-riassunto intermedio che verrà poi unito agli altri blocchi nella chiamata finale.

${buildSharedRules(config)}

ISTRUZIONI PER IL MINI-RIASSUNTO:
- Estrai TUTTE le informazioni rilevanti (testi e 🎙️ vocali) divise in *💼 LAVORO* e *🏠 VITA PRIVATA*.
- Mantieni sempre i nomi esatti di chat, gruppi, mittenti, orari e dettagli tecnici.
- Segnala esplicitamente cosa risulta già gestito/risolto grazie ai messaggi [IO] e cosa invece risulta ancora aperto in questo blocco (nota: una questione aperta nel blocco 1 potrebbe essere stata risolta da [IO] nel blocco 2, quindi riporta gli elementi chiave in modo chiaro per il merge finale).
`.trim();
}

function buildMergeSystemPrompt(mode, dateLabel, sinceLabel, config = {}) {
    const basePrompt =
        mode === 'evening'
            ? buildEveningSystemPrompt(dateLabel, sinceLabel, config)
            : buildMorningSystemPrompt(dateLabel, config);

    return `
${basePrompt}

ISTRUZIONI AGGIUNTIVE DI MERGE:
- Riceverai i mini-riassunti cronologici di più blocchi della giornata (es. Mattina/Pomeriggio e Sera/Notte).
- Uniscili in un UNICO messaggio finale coerente, eliminando duplicati.
- ATTENZIONE ALLA RISOLUZIONE TRA BLOCCHI: se un problema o una domanda era "🔴 Da fare" in un blocco precedente ma nei blocchi successivi l'utente ([IO]) ha risposto o risolto, aggiorna lo stato finale a "✅ Già risolto / Gestito"!
- Rispetta rigorosamente la struttura finale WhatsApp richiesta sopra.
`.trim();
}

module.exports = {
    buildMorningSystemPrompt,
    buildEveningSystemPrompt,
    buildChunkSystemPrompt,
    buildMergeSystemPrompt
};

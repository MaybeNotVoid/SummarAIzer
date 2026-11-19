function withTimeout(promise, ms, label) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout (${ms}ms) su ${label}`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function formatNumberFromJid(jid) {
    if (!jid) return 'Sconosciuto';
    return String(jid).split('@')[0];
}

class ContactsCache {
    constructor() {
        this.chats = new Map();
        this.contacts = new Map();
        this.lastRefreshAt = 0;
        this.isRefreshing = false;
    }

    async refreshFromClient(client) {
        if (!client || this.isRefreshing) return;
        this.isRefreshing = true;

        try {
            // Percorso ultra-veloce via pupPage.evaluate (come get_id.js, evita serializzazione pesante WWebJS)
            if (client.pupPage && typeof client.pupPage.evaluate === 'function') {
                const snapshot = await withTimeout(
                    client.pupPage.evaluate(() => {
                        const result = { chats: [], contacts: [], selfLid: null, selfWid: null };
                        try {
                            const meUser = window.require?.('WAWebUserPrefsMeUser');
                            result.selfWid = meUser?.getMaybeMePnUser?.()?._serialized || null;
                            result.selfLid = meUser?.getMaybeMeLidUser?.()?._serialized || null;
                        } catch {}

                        try {
                            const chatCol =
                                window.require?.('WAWebCollections')?.Chat ||
                                window.Store?.Chat;
                            const chatModels =
                                typeof chatCol?.getModelsArray === 'function'
                                    ? chatCol.getModelsArray()
                                    : chatCol?.models || [];

                            for (const c of chatModels) {
                                const id = c?.id?._serialized || (typeof c?.id === 'string' ? c.id : '');
                                if (!id) continue;
                                result.chats.push({
                                    id,
                                    name:
                                        c.name ||
                                        c.formattedTitle ||
                                        c.contact?.name ||
                                        c.contact?.pushname ||
                                        '',
                                    isGroup: Boolean(c.isGroup || id.endsWith('@g.us'))
                                });
                            }
                        } catch {}

                        try {
                            const contactCol =
                                window.require?.('WAWebCollections')?.Contact ||
                                window.Store?.Contact;
                            const contactModels =
                                typeof contactCol?.getModelsArray === 'function'
                                    ? contactCol.getModelsArray()
                                    : contactCol?.models || [];

                            for (const ct of contactModels) {
                                const id = ct?.id?._serialized || (typeof ct?.id === 'string' ? ct.id : '');
                                if (!id) continue;
                                result.contacts.push({
                                    id,
                                    savedName: ct.name || '',
                                    pushname: ct.pushname || '',
                                    shortName: ct.shortName || '',
                                    number: ct.userid || id.split('@')[0]
                                });
                            }
                        } catch {}

                        return result;
                    }),
                    15000,
                    'pupPage.evaluate(WAWebCollections)'
                );

                if (snapshot.selfLid) client.selfLid = snapshot.selfLid;
                if (snapshot.selfWid) client.selfWid = snapshot.selfWid;

                for (const chat of snapshot.chats || []) {
                    this.chats.set(chat.id, {
                        id: chat.id,
                        name: chat.name || formatNumberFromJid(chat.id),
                        isGroup: Boolean(chat.isGroup)
                    });
                }

                for (const contact of snapshot.contacts || []) {
                    this.contacts.set(contact.id, contact);
                }
            } else {
                // Fallback per client mock nei test
                if (typeof client.getChats === 'function') {
                    const chats = await withTimeout(client.getChats(), 15000, 'client.getChats()');
                    for (const chat of chats || []) {
                        const id = chat?.id?._serialized;
                        if (!id) continue;
                        this.chats.set(id, {
                            id,
                            name: chat.name || formatNumberFromJid(id),
                            isGroup: Boolean(chat.isGroup || id.endsWith('@g.us'))
                        });
                    }
                }
                if (typeof client.getContacts === 'function') {
                    const contacts = await withTimeout(client.getContacts(), 15000, 'client.getContacts()');
                    for (const contact of contacts || []) {
                        const id = contact?.id?._serialized;
                        if (!id) continue;
                        this.contacts.set(id, {
                            id,
                            savedName: contact.name || '',
                            pushname: contact.pushname || '',
                            shortName: contact.shortName || '',
                            number: contact.number || formatNumberFromJid(id)
                        });
                    }
                }
            }
        } catch (err) {
            console.warn('[ContactsCache] Impossibile aggiornare cache:', err.message);
        } finally {
            this.lastRefreshAt = Date.now();
            this.isRefreshing = false;
        }

        console.log(
            `[ContactsCache] Cache pronta: ${this.chats.size} chat, ${this.contacts.size} contatti.`
        );
    }

    getChatInfo(chatId) {
        if (!chatId) return { id: '', name: 'Sconosciuto', isGroup: false };
        const cached = this.chats.get(chatId);
        if (cached) return cached;

        const isGroup = String(chatId).endsWith('@g.us');
        if (!isGroup) {
            const contact = this.contacts.get(chatId);
            if (contact) {
                return {
                    id: chatId,
                    name: contact.savedName || contact.pushname || contact.number,
                    isGroup: false
                };
            }
        }

        return {
            id: chatId,
            name: formatNumberFromJid(chatId),
            isGroup
        };
    }

    getContactDisplayName(contactId, fallbackPushname = '') {
        if (!contactId) return fallbackPushname || 'Sconosciuto';
        const contact = this.contacts.get(contactId);
        if (contact) {
            return contact.savedName || contact.pushname || fallbackPushname || contact.number;
        }
        return fallbackPushname || formatNumberFromJid(contactId);
    }

    resolveMessageMetadata(msg) {
        const fromMe = Boolean(msg.fromMe);
        const chatId = fromMe ? (msg.to || msg.from) : (msg.from || msg.to);
        const isGroup = Boolean(chatId && String(chatId).endsWith('@g.us'));
        const chatInfo = this.getChatInfo(chatId);

        const senderId = fromMe
            ? (msg.from || 'ME')
            : (isGroup ? (msg.author || msg.from) : msg.from);

        const notifyName = msg?._data?.notifyName || '';
        const senderName = fromMe
            ? 'IO'
            : this.getContactDisplayName(senderId, notifyName);

        let chatName = chatInfo.name;
        if (!isGroup && (!chatName || chatName === formatNumberFromJid(chatId))) {
            chatName = this.getContactDisplayName(chatId, fromMe ? '' : notifyName);
        }

        return {
            chatId,
            chatName,
            isGroup,
            senderId,
            senderName,
            fromMe
        };
    }
}

module.exports = {
    ContactsCache
};

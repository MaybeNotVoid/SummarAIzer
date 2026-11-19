require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { loadConfig } = require('./src/config');
const { matchesKeyword } = require('./src/categorizer');

const config = loadConfig();

const client = new Client({
    authStrategy: new LocalAuth({ clientId: config.sessionName }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

console.log('Inizializzazione WhatsApp Client per elenco gruppi e contatti di lavoro...');

client.on('qr', qr => {
    console.log('Scansiona questo codice QR:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('✅ Autenticazione riuscita!');
});

client.on('auth_failure', msg => {
    console.error('❌ Autenticazione fallita:', msg);
});

client.on('ready', async () => {
    console.log('Client pronto! Recupero gruppi e contatti...');
    try {
        await new Promise(res => setTimeout(res, 2500));

        const selfId = client.info?.wid?._serialized || 'Sconosciuto';
        console.log(`\n👤 IL TUO ID WHATSAPP (Self-Chat): ${selfId}`);

        const chats = await client.getChats();
        const groups = chats.filter(c => c.isGroup || c.id?._serialized?.endsWith('@g.us'));

        console.log('\n================ GRUPPI TROVATI ================');
        if (groups.length === 0) {
            console.log('Nessun gruppo trovato.');
        } else {
            for (const g of groups) {
                const isWorkHint = matchesKeyword(g.name, config.workGroupKeywords);
                const tag = isWorkHint ? ' [💼 AUTO-WORK]' : '';
                console.log(`NOME: "${g.name}" -> ID: ${g.id._serialized}${tag}`);
            }
        }
        console.log('================================================');

        if (config.workContactKeywords.length > 0) {
            const contacts = await client.getContacts();
            const workContacts = contacts.filter(
                c =>
                    c.name &&
                    matchesKeyword(c.name, config.workContactKeywords, { wordBoundary: true })
            );

            console.log(
                `\n========= CONTATTI LAVORO (${config.workContactKeywords.join(', ')}) =========`
            );
            if (workContacts.length === 0) {
                console.log('Nessun contatto salvato corrispondente trovato.');
            } else {
                for (const c of workContacts) {
                    console.log(`CONTATTO: "${c.name}" -> ID: ${c.id._serialized}`);
                }
            }
            console.log('================================================\n');
        }

        console.log(
            'Suggerimento: copia gli ID dei gruppi di lavoro in WORK_GROUP_IDS nel file .env.'
        );
    } catch (err) {
        console.error('Errore nel recupero delle chat:', err.message);
    } finally {
        await client.destroy();
        process.exit(0);
    }
});

client.initialize();

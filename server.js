// Local control panel. Start with:  npm start   then open http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createBot } = require('./e2e/bot');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const APP_USERNAME = process.env.APP_USERNAME || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

if (!LOOPBACK_HOSTS.has(HOST) && !APP_PASSWORD) {
    throw new Error('APP_PASSWORD is required when HOST is not a loopback address.');
}
if (APP_PASSWORD && Buffer.byteLength(APP_PASSWORD, 'utf8') < 16) {
    throw new Error('APP_PASSWORD must be at least 16 characters long.');
}

const REL = { father: 1, mother: 1, son: 1, daughter: 1, brother: 1, sister: 1, spouse: 1 };
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Any number of fully independent bots. Each has its own browser session, config, status and log.
// Only the bot list (id + name) is saved to disk. Credentials are never stored.
const MAX_BOTS = Math.max(1, parseInt(process.env.MAX_BOTS, 10) || 20);
const DATA_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'bots.json');
const bots = {};
let nextBotId = 1;

function cleanName(n) {
    return String(n == null ? '' : n).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}
function botList() { return Object.values(bots).map((b) => ({ id: b.id, name: b.name })); }
function saveBots() {
    try {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify({ nextBotId, bots: botList() }, null, 2));
    } catch (e) { console.error('Could not save the bot list (ignored):', e.message); }
}
function addBot(id, name) {
    bots[id] = { id, name, running: false, logs: [], progress: null, username: '', runner: createBot(id) };
    nextBotId = Math.max(nextBotId, id + 1);
    return bots[id];
}
(function loadBots() {
    try {
        const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        for (const b of saved.bots || []) {
            const name = cleanName(b.name);
            if (Number.isInteger(b.id) && b.id > 0 && name && !bots[b.id]) addBot(b.id, name);
        }
        if (Number.isInteger(saved.nextBotId)) nextBotId = Math.max(nextBotId, saved.nextBotId);
    } catch (e) { /* first run, no file yet */ }
    if (!Object.keys(bots).length) { addBot(nextBotId, 'Bot 1'); saveBots(); }
})();
const clients = new Set();

// The bots must never crash the server, whatever a browser or the website does.
process.on('uncaughtException', (e) => console.error('Uncaught exception (ignored):', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection (ignored):', e && e.stack || e));

function safeEqual(actual, expected) {
    const actualBuffer = Buffer.from(actual, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    return actualBuffer.length === expectedBuffer.length
        && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAuthorized(req) {
    if (!APP_PASSWORD) return true;
    const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(req.headers.authorization || '');
    if (!match) return false;

    const credentials = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = credentials.indexOf(':');
    if (separator < 0) return false;

    return safeEqual(credentials.slice(0, separator), APP_USERNAME)
        && safeEqual(credentials.slice(separator + 1), APP_PASSWORD);
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(text) {
    const d = new Date();
    const t = `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] `;
    return String(text).replace(/^(\n*)/, `$1${t}`);
}

function broadcast(obj) {
    const line = JSON.stringify(obj);
    for (const c of clients) c.write(`data: ${line}\n\n`);
}

function emit(botId, type, data) {
    if (!bots[botId]) return;
    if (type === 'progress') bots[botId].progress = data;
    if (type === 'log') {
        data = stamp(data);
        const b = bots[botId];
        b.logs.push(data);
        if (b.logs.length > 2000) b.logs.shift();
    }
    const line = JSON.stringify({ bot: botId, type, data });
    for (const c of clients) c.write(`data: ${line}\n\n`);
}

function startBot(botId, cfg) {
    const b = bots[botId];
    b.running = true; b.logs = []; b.progress = null; b.username = cfg.username;
    emit(botId, 'status', { running: true });
    for (const other of Object.values(bots)) {
        if (other.id !== botId && other.running && other.username === cfg.username) {
            emit(botId, 'log', `⚠️ "${other.name}" is running with the SAME account. The wishlist belongs to the account, so the two bots can clear each other's wishlist. Use a different account per bot.`);
        }
    }
    b.runner.run(cfg, (line) => emit(botId, 'log', line), (prog) => emit(botId, 'progress', prog))
        .catch((e) => emit(botId, 'log', `🛑 ${e.message}`))
        .finally(() => { b.running = false; emit(botId, 'status', { running: false }); });
}

function stopBot(botId) {
    const b = bots[botId];
    if (b.running) { emit(botId, 'log', '⏹ Stop requested...'); b.runner.stop(); }
}

function validate(b) {
    const err = [];
    if (!b.username || !b.password) err.push('Enter the username and password.');
    const dates = (b.dates || []).filter(Boolean).map((d) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
        if (!m) { err.push(`Invalid date: ${d}`); return null; }
        const day = String(parseInt(m[3], 10)), month = MONTHS[parseInt(m[2], 10) - 1];
        return { label: `${month} ${day}`, day, month, year: m[1] };
    }).filter(Boolean);
    if (!dates.length) err.push('Add at least one date.');
    const rows = [...new Set(String(b.pilgrimRows || '').split(/[\s,]+/).filter(Boolean).map(Number))];
    if (!rows.length || rows.some((n) => !Number.isInteger(n) || n < 1)) err.push('Pilgrim rows must be numbers from 1, e.g. 2,3,4,5.');
    const checkNominee = (n, who) => {
        if (!/^[a-zA-Z ]+$/.test(n.name || '') || n.name.length > 32) err.push(`${who}: name must be letters/spaces, max 32.`);
        if (!/^[0-9]{1,3}$/.test(String(n.age || ''))) err.push(`${who}: age must be 1 to 3 digits.`);
        if (!(String(n.relation || '').toLowerCase() in REL)) err.push(`${who}: choose a relation.`);
    };
    checkNominee(b.nominee || {}, 'Nominee');
    const overrides = {};
    for (const o of b.overrides || []) {
        checkNominee(o, `Row ${o.row} nominee`);
        overrides[o.row] = { name: o.name, age: String(o.age), relation: o.relation };
    }
    const slots = String(b.slots || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (b.slotMode === 'particular' && !slots.length) err.push('Add at least one preferred slot, or switch to Auto.');
    return { err, cfg: {
        username: b.username, password: b.password, dates, pilgrimRows: rows,
        nominee: { name: (b.nominee || {}).name, age: String((b.nominee || {}).age), relation: (b.nominee || {}).relation },
        overrides, slotMode: b.slotMode === 'particular' ? 'particular' : 'auto', slots,
        routeValue: String(b.routeValue || '1'),
        maxRetries: Math.min(100, Math.max(1, Math.floor(+b.maxRetries) || 5)),
        retryDelaySec: Math.max(1, +b.retryDelaySec || 5),
        cooldownSec: Math.max(1, +b.cooldownSec || 60),
        headless: b.headless !== false, useInstalledChrome: !!b.useInstalledChrome,
    } };
}

function readBody(req) {
    return new Promise((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } }); });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
    if (!isAuthorized(req)) {
        res.writeHead(401, {
            'WWW-Authenticate': 'Basic realm="Sabarimala Booking Console", charset="UTF-8"',
            'Cache-Control': 'no-store',
        });
        return res.end('Authentication required.');
    }

    const url = String(req.url || '').split('?')[0];

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (url === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const init = {};
        for (const b of Object.values(bots)) init[b.id] = { running: b.running, logs: b.logs, progress: b.progress };
        res.write(`data: ${JSON.stringify({ type: 'init', data: { list: botList(), bots: init } })}\n\n`);
        clients.add(res);
        return req.on('close', () => clients.delete(res));
    }

    // POST /api/bots {name}                 -> add a bot
    // POST /api/bots/<id>/remove            -> remove a stopped bot
    // POST /api/bots/<id>/start | /stop     (/api/stop alone stops every bot)
    if (req.method === 'POST' && url === '/api/bots') {
        const body = await readBody(req);
        const name = cleanName(body.name);
        if (!name) return json(res, 400, { errors: ['Enter a bot name.'] });
        if (Object.keys(bots).length >= MAX_BOTS) return json(res, 400, { errors: [`Limit of ${MAX_BOTS} bots reached.`] });
        if (Object.values(bots).some((b) => b.name.toLowerCase() === name.toLowerCase())) {
            return json(res, 400, { errors: [`A bot named "${name}" already exists.`] });
        }
        const b = addBot(nextBotId, name);
        saveBots();
        broadcast({ type: 'bots', data: { list: botList() } });
        return json(res, 200, { ok: true, id: b.id, name: b.name });
    }

    const m = /^\/api\/(?:bots\/(\d+)\/)?(start|stop|remove)$/.exec(url);
    if (req.method === 'POST' && m) {
        const action = m[2];
        if (!m[1] && action === 'stop') {
            Object.keys(bots).forEach((id) => stopBot(+id));
            return json(res, 200, { ok: true });
        }
        if (!m[1]) { res.writeHead(404); return res.end('Not found'); }
        const botId = parseInt(m[1], 10);
        if (!bots[botId]) return json(res, 404, { errors: [`There is no bot with id ${botId}.`] });
        const label = `"${bots[botId].name}"`;

        if (action === 'stop') {
            stopBot(botId);
            return json(res, 200, { ok: true });
        }
        if (action === 'remove') {
            if (bots[botId].running) return json(res, 409, { errors: [`Stop ${label} before removing it.`] });
            if (Object.keys(bots).length <= 1) return json(res, 400, { errors: ['At least one bot must remain.'] });
            delete bots[botId];
            saveBots();
            broadcast({ type: 'bots', data: { list: botList() } });
            return json(res, 200, { ok: true });
        }
        if (bots[botId].running) return json(res, 409, { errors: [`${label} is already running.`] });
        const { err, cfg } = validate(await readBody(req));
        if (err.length) return json(res, 400, { errors: err });
        startBot(botId, cfg);
        return json(res, 200, { ok: true });
    }
    res.writeHead(404); res.end('Not found');
}).listen(PORT, HOST, () => console.log(`Open http://localhost:${PORT}  (add as many bots as you need with the + Add bot button)`));

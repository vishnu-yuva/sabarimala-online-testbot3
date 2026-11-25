// browserPool.js - ONE Chromium process tree shared by every bot.
//
// Why: launching a separate Chromium per bot needs ~10 OS processes/threads each. On small
// containers (Railway, Docker with a pids limit) the 2nd/3rd/4th launch fails with
//   "spawn .../headless_shell EAGAIN".
// Each bot now gets its own isolated browser CONTEXT (own cookies, own login, own storage),
// which is as clean as a fresh browser but costs a fraction of the processes.
//
// Set SHARED_BROWSER=0 to go back to one browser per session.

const { chromium } = require('playwright');

const SHARED = process.env.SHARED_BROWSER !== '0';

// Flags that keep Chromium light inside containers.
const LAUNCH_ARGS = [
    '--disable-dev-shm-usage',          // /dev/shm is tiny in Docker
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-zygote',                      // one process fewer (sandbox is already off in Playwright)
];

const pool = new Map(); // key -> { browser, launching, users }
let launchChain = Promise.resolve(); // launches run one at a time, never in a burst

const keyOf = (o) => `${o.headless ? 'h' : 'w'}:${o.useInstalledChrome ? 'chrome' : 'chromium'}`;
const isEagain = (e) => /EAGAIN|ENOMEM|Resource temporarily unavailable/i.test(String(e && e.message || e));

function launchOnce(opts) {
    const launchOpts = { headless: opts.headless, args: LAUNCH_ARGS };
    if (opts.useInstalledChrome) launchOpts.channel = 'chrome';
    return chromium.launch(launchOpts);
}

/** Launch with a short back-off when the OS says "try again" (EAGAIN). */
async function launchWithBackoff(opts, log) {
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
        try { return await launchOnce(opts); }
        catch (e) {
            lastErr = e;
            if (!isEagain(e)) throw e;
            log(`⚠️ The system is out of processes/memory (attempt ${attempt}/4). Waiting ${attempt * 3}s before trying to start the browser again...`);
            await new Promise((r) => setTimeout(r, attempt * 3000));
        }
    }
    throw lastErr;
}

function serialized(fn) {
    const run = launchChain.then(fn, fn);
    launchChain = run.catch(() => {});
    return run;
}

/**
 * Returns { newPage(pageOpts), close() } for one bot session.
 * close() closes only this session's context; the shared browser stays up while others use it.
 */
async function acquire(opts, log = () => {}) {
    if (!SHARED) {
        const browser = await serialized(() => launchWithBackoff(opts, log));
        return {
            async newPage(pageOpts) { return browser.newPage(pageOpts); },
            async close() { await browser.close().catch(() => {}); },
            kill() { return browser.close().catch(() => {}); },
        };
    }

    const key = keyOf(opts);
    let entry = await serialized(async () => {
        let e = pool.get(key);
        if (e && e.browser.isConnected()) return e;
        const browser = await launchWithBackoff(opts, log);
        e = { browser, users: 0 };
        pool.set(key, e);
        browser.on('disconnected', () => { if (pool.get(key) === e) pool.delete(key); });
        return e;
    });

    entry.users++;
    let context = null;
    let released = false;
    const release = async () => {
        if (released) return;
        released = true;
        entry.users--;
        // Close the browser when the last bot is done, so nothing is left running.
        if (entry.users <= 0 && pool.get(key) === entry) {
            pool.delete(key);
            await entry.browser.close().catch(() => {});
        }
    };

    return {
        async newPage(pageOpts) {
            try {
                context = await entry.browser.newContext(pageOpts);
                return await context.newPage();
            } catch (e) { await this.close(); throw e; }
        },
        async close() {
            if (context) await context.close().catch(() => {});
            context = null;
            await release();
        },
        kill() { return this.close(); },
    };
}

module.exports = { acquire };

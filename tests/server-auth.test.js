const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const appDir = path.resolve(__dirname, '..');
const username = 'railway-admin';
const password = 'a-long-test-password-123';

async function getFreePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

function startServer(env) {
    const stderr = [];
    const child = spawn(process.execPath, ['server.js'], {
        cwd: appDir,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
    return { child, getStderr: () => stderr.join('') };
}

function request(port, route, { method = 'GET', auth } = {}) {
    const headers = auth
        ? { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` }
        : {};

    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, (res) => {
            const body = [];
            res.on('data', (chunk) => body.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(body).toString('utf8'),
            }));
        });
        req.setTimeout(5000, () => req.destroy(new Error('Request timed out.')));
        req.on('error', reject);
        req.end();
    });
}

async function waitForServer(port, server) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (server.child.exitCode !== null) {
            throw new Error(`Server exited before accepting requests: ${server.getStderr()}`);
        }
        try {
            return await request(port, '/');
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw new Error(`Server did not start in time: ${server.getStderr()}`);
}

async function stopServer(child) {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
}

test('network listener requires an app password', async () => {
    const { child, getStderr } = startServer({
        HOST: '0.0.0.0',
        PORT: '0',
        APP_PASSWORD: '',
    });

    const code = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error(`Server did not exit when APP_PASSWORD was missing: ${getStderr()}`));
        }, 10000);
        child.once('error', reject);
        child.once('exit', (exitCode) => {
            clearTimeout(timeout);
            resolve(exitCode);
        });
    });

    assert.notEqual(code, 0);
    assert.match(getStderr(), /APP_PASSWORD is required/);

    const weakServer = startServer({
        HOST: '0.0.0.0',
        PORT: '0',
        APP_PASSWORD: 'short',
    });
    const weakCode = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            weakServer.child.kill();
            reject(new Error(`Server did not exit with a short APP_PASSWORD: ${weakServer.getStderr()}`));
        }, 10000);
        weakServer.child.once('error', reject);
        weakServer.child.once('exit', (exitCode) => {
            clearTimeout(timeout);
            resolve(exitCode);
        });
    });

    assert.notEqual(weakCode, 0);
    assert.match(weakServer.getStderr(), /APP_PASSWORD must be at least 16 characters long/);
});

test('Basic authentication protects the UI and API', async () => {
    const port = await getFreePort();
    const server = startServer({
        HOST: '0.0.0.0',
        PORT: String(port),
        APP_USERNAME: username,
        APP_PASSWORD: password,
    });

    try {
        await waitForServer(port, server);

        const unauthenticated = await request(port, '/');
        assert.equal(unauthenticated.status, 401);
        assert.match(unauthenticated.headers['www-authenticate'], /^Basic /);

        const unauthenticatedStart = await request(port, '/api/start', { method: 'POST' });
        assert.equal(unauthenticatedStart.status, 401);

        const wrongPassword = await request(port, '/api/events', {
            auth: { username, password: 'wrong-password-12345' },
        });
        assert.equal(wrongPassword.status, 401);

        const authenticated = await request(port, '/', { auth: { username, password } });
        assert.equal(authenticated.status, 200);
        assert.match(authenticated.body, /Sabarimala booking console/);

        const authenticatedApi = await request(port, '/api/stop', {
            method: 'POST',
            auth: { username, password },
        });
        assert.equal(authenticatedApi.status, 200);
    } finally {
        await stopServer(server.child);
    }
});

test('loopback development remains available without authentication', async () => {
    const port = await getFreePort();
    const server = startServer({
        HOST: '127.0.0.1',
        PORT: String(port),
        APP_PASSWORD: '',
    });

    try {
        const response = await waitForServer(port, server);
        assert.equal(response.status, 200);
    } finally {
        await stopServer(server.child);
    }
});

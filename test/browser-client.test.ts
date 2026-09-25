import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetFor, isOurDaemon, stopSession } from '../src/browser/client.js';
import { pidAlive } from '../src/core/lock.js';
import { readSession, writeSession } from '../src/browser/session.js';

describe('browser: клиент', () => {
  it('бюджет ожидания учитывает паузу, число условий и таймаут демона', () => {
    expect(budgetFor('goto', {}, 15_000)).toBe(25_000);
    expect(budgetFor('wait', { ms: 100_000 }, 15_000)).toBe(125_000);
    expect(budgetFor('wait', { target: '#a', url: '*/x', timeout: 2_000 }, 15_000)).toBe(14_000);
    expect(budgetFor('click', { timeout: 500 }, 15_000)).toBe(10_500);
  });

  it('stop не трогает чужой процесс, на который указывает устаревший след', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, SBOX_BROWSER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'sbox-browser-stop-')) };
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const pid = child.pid!;
      writeSession({ name: 'default', pid, socket: path.join(env.SBOX_BROWSER_HOME!, 'nope.sock'), wsEndpoint: 'ws://x', executable: '/bin/true', headless: true, profile: null, viewport: { width: 1, height: 1 }, startedAt: new Date().toISOString(), cwd: '/', log: '/tmp/x.log' }, env);
      expect(isOurDaemon(pid, 'default')).toBe(false);
      const started = Date.now();
      const result = await stopSession('default', env);
      expect(result.stopped).toBe(false);
      expect(result.reason).toBe('stale');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(pidAlive(pid)).toBe(true);
      expect(readSession('default', env)).toBeNull();
    } finally {
      child.kill('SIGKILL');
    }
  });
});

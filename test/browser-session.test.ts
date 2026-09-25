import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSessionName, listSessions, readSession, sessionFile, socketPath, writeSession, type SessionInfo } from '../src/browser/session.js';

function env(): NodeJS.ProcessEnv {
  return { SBOX_BROWSER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'sbox-browser-home-')) };
}

function info(name: string, pid: number): SessionInfo {
  return { name, pid, socket: '/tmp/x.sock', wsEndpoint: 'ws://127.0.0.1:1/devtools/browser/x', executable: '/bin/true', headless: true, profile: null, viewport: { width: 1, height: 1 }, startedAt: new Date().toISOString(), cwd: '/', log: '/tmp/x.log' };
}

describe('browser: файл сессии', () => {
  it('записывает и читает живую сессию', () => {
    const e = env();
    writeSession(info('default', process.pid), e);
    expect(readSession('default', e)?.pid).toBe(process.pid);
    expect(listSessions(e).map((s) => s.name)).toEqual(['default']);
  });

  it('след мёртвого процесса удаляется при чтении', () => {
    const e = env();
    const file = writeSession(info('dead', 999_999_999), e);
    expect(fs.existsSync(file)).toBe(true);
    expect(readSession('dead', e)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('битый файл сессии не роняет клиента', () => {
    const e = env();
    const file = sessionFile('broken', e);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(readSession('broken', e)).toBeNull();
  });

  it('проверяет имя сессии и строит путь сокета по платформе', () => {
    expect(assertSessionName('app-1')).toBe('app-1');
    expect(() => assertSessionName('Bad Name')).toThrow(/BROWSER_SESSION_NAME|Имя сессии/);
    expect(socketPath('x', env(), 'win32')).toBe('\\\\.\\pipe\\sbox-browser-x');
    expect(socketPath('x', env(), 'darwin').endsWith(path.join('sessions', 'x.sock'))).toBe(true);
  });
});

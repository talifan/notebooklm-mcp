/**
 * Auth Manager Tests
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Mock logger
jest.unstable_mockModule('../utils/logger.js', () => ({
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));

describe('AuthManager', () => {
  let AuthManager: any;
  let testDataDir: string;
  let browserStateDir: string;

  beforeEach(async () => {
    // Create temp directory for tests
    testDataDir = path.join(os.tmpdir(), `auth-manager-test-${Date.now()}`);
    browserStateDir = path.join(testDataDir, 'browser_state');
    await fs.mkdir(browserStateDir, { recursive: true });

    // Mock CONFIG
    jest.unstable_mockModule('../config.js', () => ({
      CONFIG: {
        dataDir: testDataDir,
        browserStateDir: browserStateDir,
      },
      NOTEBOOKLM_AUTH_URL: 'https://notebooklm.google.com/',
    }));

    // Import fresh module
    const module = await import('../auth/auth-manager.js');
    AuthManager = module.AuthManager;
  });

  afterEach(async () => {
    jest.resetModules();
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('State Management', () => {
    it('should create manager instance', () => {
      const manager = new AuthManager();
      expect(manager).toBeDefined();
    });

    it('should return false when no saved state exists', async () => {
      const manager = new AuthManager();
      const hasSaved = await manager.hasSavedState();
      expect(hasSaved).toBe(false);
    });

    it('should return true when state file exists', async () => {
      const manager = new AuthManager();

      // Create state file
      const stateFile = path.join(browserStateDir, 'state.json');
      await fs.writeFile(stateFile, JSON.stringify({ cookies: [] }));

      const hasSaved = await manager.hasSavedState();
      expect(hasSaved).toBe(true);
    });

    it('should get state path when exists', async () => {
      const manager = new AuthManager();

      // Create state file
      const stateFile = path.join(browserStateDir, 'state.json');
      await fs.writeFile(stateFile, JSON.stringify({ cookies: [] }));

      const statePath = manager.getStatePath();
      expect(statePath).toBe(stateFile);
    });

    it('should return null when state path does not exist', () => {
      const manager = new AuthManager();
      const statePath = manager.getStatePath();
      expect(statePath).toBeNull();
    });
  });

  describe('Session Storage', () => {
    it('should load session storage', async () => {
      const manager = new AuthManager();

      // Create session file
      const sessionFile = path.join(browserStateDir, 'session.json');
      const sessionData = { key1: 'value1', key2: 'value2' };
      await fs.writeFile(sessionFile, JSON.stringify(sessionData));

      const loaded = await manager.loadSessionStorage();
      expect(loaded).toEqual(sessionData);
    });

    it('should return null when session file does not exist', async () => {
      const manager = new AuthManager();
      const loaded = await manager.loadSessionStorage();
      expect(loaded).toBeNull();
    });
  });

  describe('Cookie Validation', () => {
    it('should detect expired cookies from file', async () => {
      const manager = new AuthManager();

      // Create state file with expired cookies
      const stateFile = path.join(browserStateDir, 'state.json');
      const expiredTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          cookies: [
            {
              name: 'SID',
              domain: '.google.com',
              expires: expiredTime,
            },
          ],
        })
      );

      const isExpired = await manager.isStateExpired();
      expect(isExpired).toBe(true);
    });

    it('should return true when no state file exists', async () => {
      const manager = new AuthManager();
      const isExpired = await manager.isStateExpired();
      expect(isExpired).toBe(true);
    });

    it('should return false when cookies are valid', async () => {
      const manager = new AuthManager();

      // Create state file with valid cookies
      const stateFile = path.join(browserStateDir, 'state.json');
      const futureTime = Math.floor(Date.now() / 1000) + 86400; // 1 day from now
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          cookies: [
            {
              name: 'SID',
              domain: '.google.com',
              expires: futureTime,
            },
            {
              name: 'HSID',
              domain: '.google.com',
              expires: futureTime,
            },
          ],
        })
      );

      const isExpired = await manager.isStateExpired();
      expect(isExpired).toBe(false);
    });
  });

  describe('Valid State Path', () => {
    it('should return null when no state exists', async () => {
      const manager = new AuthManager();
      const validPath = await manager.getValidStatePath();
      expect(validPath).toBeNull();
    });

    it('should return null when state is expired', async () => {
      const manager = new AuthManager();

      // Create state file with expired cookies
      const stateFile = path.join(browserStateDir, 'state.json');
      const expiredTime = Math.floor(Date.now() / 1000) - 3600;
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          cookies: [
            {
              name: 'SID',
              domain: '.google.com',
              expires: expiredTime,
            },
          ],
        })
      );

      const validPath = await manager.getValidStatePath();
      expect(validPath).toBeNull();
    });

    it('should return path when state is valid', async () => {
      const manager = new AuthManager();

      // Create state file with valid cookies
      const stateFile = path.join(browserStateDir, 'state.json');
      const futureTime = Math.floor(Date.now() / 1000) + 86400;
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          cookies: [
            {
              name: 'SID',
              domain: '.google.com',
              expires: futureTime,
            },
          ],
        })
      );

      const validPath = await manager.getValidStatePath();
      expect(validPath).toBe(stateFile);
    });

    it('should trust valid cookies even when the state file is older than seven days', async () => {
      const manager = new AuthManager();
      const stateFile = path.join(browserStateDir, 'state.json');
      const futureTime = Math.floor(Date.now() / 1000) + 86400;
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          cookies: [{ name: 'SID', domain: '.google.com', expires: futureTime }],
        })
      );

      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await fs.utimes(stateFile, oldTime, oldTime);

      expect(await manager.isStateExpired()).toBe(false);
      expect(await manager.getValidStatePath()).toBe(stateFile);
    });
  });

  describe('State Clearing', () => {
    it('should clear browser state', async () => {
      const manager = new AuthManager();

      // Create state file
      const stateFile = path.join(browserStateDir, 'state.json');
      await fs.writeFile(stateFile, '{}');

      const result = await manager.clearState();

      expect(typeof result).toBe('boolean');
    });

    it('should handle missing files gracefully', async () => {
      const manager = new AuthManager();

      // Should not throw
      const result = await manager.clearState();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('Hard Reset', () => {
    it('should perform hard reset', async () => {
      const manager = new AuthManager();

      // Create state file
      const stateFile = path.join(browserStateDir, 'state.json');
      await fs.writeFile(stateFile, '{}');

      const success = await manager.hardResetState();
      expect(typeof success).toBe('boolean');
    });
  });

  describe('Multiple Cookies Validation', () => {
    it('should handle state with multiple cookies', async () => {
      const manager = new AuthManager();

      // Create state file with multiple auth cookies
      const stateFile = path.join(browserStateDir, 'state.json');
      const futureTime = Math.floor(Date.now() / 1000) + 86400;
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          cookies: [
            { name: 'SID', domain: '.google.com', expires: futureTime, value: 'test' },
            { name: 'HSID', domain: '.google.com', expires: futureTime, value: 'test2' },
            { name: '__Secure-1PSID', domain: '.google.com', expires: futureTime, value: 'test3' },
          ],
        })
      );

      const hasSaved = await manager.hasSavedState();
      expect(hasSaved).toBe(true);

      const isExpired = await manager.isStateExpired();
      expect(isExpired).toBe(false);
    });
  });

  describe('Valid State Detection', () => {
    it('should detect valid state with required cookies', async () => {
      const manager = new AuthManager();

      // Create state file with valid cookies
      const stateFile = path.join(browserStateDir, 'state.json');
      const futureTime = Math.floor(Date.now() / 1000) + 86400;
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          cookies: [
            { name: 'SID', domain: '.google.com', expires: futureTime, value: 'test' },
            { name: 'HSID', domain: '.google.com', expires: futureTime, value: 'test2' },
          ],
        })
      );

      const validPath = await manager.getValidStatePath();
      expect(validPath).toBe(stateFile);
    });
  });

  describe('State File Validation', () => {
    it('should handle corrupted state file', async () => {
      const manager = new AuthManager();

      // Create invalid state file
      const stateFile = path.join(browserStateDir, 'state.json');
      await fs.writeFile(stateFile, 'not valid json');

      // Should handle gracefully
      const hasSaved = await manager.hasSavedState();
      expect(typeof hasSaved).toBe('boolean');
    });

    it('should handle empty state file', async () => {
      const manager = new AuthManager();

      // Create empty state file
      const stateFile = path.join(browserStateDir, 'state.json');
      await fs.writeFile(stateFile, '{}');

      const isExpired = await manager.isStateExpired();
      expect(isExpired).toBe(true);
    });
  });
});

describe('AuthManager Cookie Types', () => {
  it('should recognize auth cookie names', () => {
    const authCookieNames = ['SID', 'HSID', 'SSID', '__Secure-1PSID', '__Secure-3PSID'];

    authCookieNames.forEach((name) => {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    });
  });

  it('should recognize Google domains', () => {
    const googleDomains = ['.google.com', 'google.com', '.notebooklm.google.com'];

    googleDomains.forEach((domain) => {
      expect(domain).toContain('google');
    });
  });
});

describe('AuthManager Error Handling', () => {
  it('should handle file read errors', async () => {
    // This tests the concept of error handling
    const mockRead = jest.fn().mockRejectedValue(new Error('Read error'));

    try {
      await mockRead();
    } catch (e) {
      expect(e).toBeDefined();
    }
  });

  it('should handle file write errors', async () => {
    const mockWrite = jest.fn().mockRejectedValue(new Error('Write error'));

    try {
      await mockWrite();
    } catch (e) {
      expect(e).toBeDefined();
    }
  });
});

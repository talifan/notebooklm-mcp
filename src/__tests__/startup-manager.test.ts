/**
 * Tests for StartupManager
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock logger
jest.unstable_mockModule('../utils/logger.js', () => ({
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    dim: jest.fn(),
  },
}));

// Mock config
jest.unstable_mockModule('../config.js', () => ({
  CONFIG: {
    dataDir: '/tmp/test-data',
    browserStateDir: '/tmp/test-data/browser_state',
    autoLoginTimeoutMs: 60000,
    headless: true,
    stealthEnabled: true,
    viewport: { width: 1920, height: 1080 },
    uiLocale: 'en',
  },
  LOCALE_BROWSER_SETTINGS: {
    fr: { locale: 'fr-FR', timezone: 'Europe/Paris' },
    en: { locale: 'en-US', timezone: 'America/New_York' },
    de: { locale: 'de-DE', timezone: 'Europe/Berlin' },
    ja: { locale: 'ja-JP', timezone: 'Asia/Tokyo' },
  },
  NOTEBOOKLM_AUTH_URL: 'https://notebooklm.google.com/',
  applyBrowserOptions: jest.fn((options: any) => options),
}));

// Mock crypto for maskEmail
jest.unstable_mockModule('../accounts/crypto.js', () => ({
  maskEmail: jest.fn((email: string) => email.replace(/(.{2}).*(@.*)/, '$1***$2')),
}));

// Mock account manager
const mockAccountManager = {
  getAccountCount: jest.fn(() => 0),
  getCurrentAccountId: jest.fn(() => null),
  getBestAccount: jest.fn(() => null),
  getAccount: jest.fn(() => null),
  isAutoLoginEnabled: jest.fn(() => false),
  saveCurrentAccountId: jest.fn(),
  recordLoginSuccess: jest.fn(),
};

jest.unstable_mockModule('../accounts/account-manager.js', () => ({
  getAccountManager: jest.fn(async () => mockAccountManager),
  AccountManager: jest.fn(),
}));

// Mock AutoLoginManager
jest.unstable_mockModule('../accounts/auto-login-manager.js', () => ({
  AutoLoginManager: jest.fn().mockImplementation(() => ({
    performAutoLogin: jest.fn(() => ({ success: false, error: 'Mock error' })),
  })),
}));

// Import after mocks
const { AuthManager } = await import('../auth/auth-manager.js');
const { StartupManager } = await import('../startup/startup-manager.js');

describe('StartupManager', () => {
  let mockAuthManager: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthManager = {
      getValidStatePath: jest.fn(() => null),
      hasSavedState: jest.fn(() => false),
    };

    // Reset mock account manager
    mockAccountManager.getAccountCount.mockReturnValue(0);
    mockAccountManager.getCurrentAccountId.mockReturnValue(null);
    mockAccountManager.getBestAccount.mockReturnValue(null);
    mockAccountManager.getAccount.mockReturnValue(null);
    mockAccountManager.isAutoLoginEnabled.mockReturnValue(false);
  });

  describe('constructor', () => {
    it('should create instance with AuthManager', () => {
      const startupManager = new StartupManager(mockAuthManager);
      expect(startupManager).toBeInstanceOf(StartupManager);
    });
  });

  describe('startup with no accounts', () => {
    it('should return serverStarted true even if not authenticated', async () => {
      const startupManager = new StartupManager(mockAuthManager);

      const result = await startupManager.startup();

      expect(result.serverStarted).toBe(true);
      expect(result.success).toBe(true);
      expect(result.authenticated).toBe(false);
    });

    it('should include "No accounts configured" in details', async () => {
      const startupManager = new StartupManager(mockAuthManager);

      const result = await startupManager.startup();

      expect(result.details).toContain('No accounts configured');
    });
  });

  describe('startup with legacy authentication', () => {
    it('should detect and use legacy authentication', async () => {
      mockAuthManager.getValidStatePath.mockReturnValue('/path/to/legacy/state.json');

      const startupManager = new StartupManager(mockAuthManager);
      const result = await startupManager.startup();

      expect(result.success).toBe(true);
      expect(result.authenticated).toBe(true);
      expect(result.details).toContain('Legacy authentication found');
    });
  });

  describe('getStatus', () => {
    it('should return authenticated false when no valid state', async () => {
      const startupManager = new StartupManager(mockAuthManager);

      const status = await startupManager.getStatus();

      expect(status.authenticated).toBe(false);
    });

    it('should detect expired cookies', async () => {
      mockAuthManager.getValidStatePath.mockReturnValue(null);
      mockAuthManager.hasSavedState.mockReturnValue(true);

      const startupManager = new StartupManager(mockAuthManager);
      const status = await startupManager.getStatus();

      expect(status.cookiesExpired).toBe(true);
    });

    it('should return authenticated true when valid state exists', async () => {
      mockAuthManager.getValidStatePath.mockReturnValue('/valid/state.json');
      mockAuthManager.hasSavedState.mockReturnValue(true);

      const startupManager = new StartupManager(mockAuthManager);
      const status = await startupManager.getStatus();

      expect(status.authenticated).toBe(true);
      expect(status.cookiesExpired).toBe(false);
    });
  });
});

describe('StartupResult interface', () => {
  it('should have required properties', () => {
    const result = {
      success: true,
      serverStarted: true,
      authenticated: false,
      message: 'Test message',
      details: ['detail 1', 'detail 2'],
    };

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('serverStarted');
    expect(result).toHaveProperty('authenticated');
    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('details');
  });

  it('should allow optional properties', () => {
    const result = {
      success: true,
      serverStarted: true,
      authenticated: true,
      accountId: 'account-123',
      accountEmail: 'test@example.com',
      message: 'Connected',
      details: [],
    };

    expect(result.accountId).toBe('account-123');
    expect(result.accountEmail).toBe('test@example.com');
  });

  it('should allow error property when not authenticated', () => {
    const result = {
      success: false,
      serverStarted: true,
      authenticated: false,
      error: 'Connection failed',
      message: 'Error occurred',
      details: ['error detail'],
    };

    expect(result.error).toBe('Connection failed');
  });
});

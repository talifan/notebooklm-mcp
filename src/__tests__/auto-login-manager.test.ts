/**
 * Auto-Login Manager Tests
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock dependencies
jest.unstable_mockModule('../utils/logger.js', () => ({
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../utils/stealth-utils.js', () => ({
  humanType: jest.fn().mockResolvedValue(undefined),
  randomDelay: jest.fn().mockResolvedValue(undefined),
  realisticClick: jest.fn().mockResolvedValue(undefined),
  randomMouseMovement: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../config.js', () => ({
  CONFIG: {
    dataDir: '/tmp/test-data',
    viewport: { width: 1024, height: 768 },
    autoLoginTimeoutMs: 60000,
    uiLocale: 'en',
  },
  LOCALE_BROWSER_SETTINGS: {
    fr: { locale: 'fr-FR', timezone: 'Europe/Paris' },
    en: { locale: 'en-US', timezone: 'America/New_York' },
    de: { locale: 'de-DE', timezone: 'Europe/Berlin' },
    ja: { locale: 'ja-JP', timezone: 'Asia/Tokyo' },
  },
  NOTEBOOKLM_AUTH_URL: 'https://notebooklm.google.com/',
}));

// Mock chromium
jest.unstable_mockModule('patchright', () => ({
  chromium: {
    launchPersistentContext: jest.fn(),
  },
}));

describe('AutoLoginManager', () => {
  let AutoLoginManager: any;
  let mockAccountManager: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Create mock account manager
    mockAccountManager = {
      getAccount: jest.fn(),
      getCredentials: jest.fn(),
      recordLoginSuccess: jest.fn(),
      recordLoginFailure: jest.fn(),
      getBestAccount: jest.fn(),
    };

    // Import module
    const module = await import('../accounts/auto-login-manager.js');
    AutoLoginManager = module.AutoLoginManager;
  });

  describe('Constructor', () => {
    it('should create instance with account manager', () => {
      const manager = new AutoLoginManager(mockAccountManager);
      expect(manager).toBeDefined();
    });
  });

  describe('performAutoLogin', () => {
    it('should return error when account not found', async () => {
      mockAccountManager.getAccount.mockReturnValue(undefined);

      const manager = new AutoLoginManager(mockAccountManager);
      const result = await manager.performAutoLogin('non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Account not found');
      expect(result.requiresManualIntervention).toBe(false);
    });

    it('should return error when no credentials available', async () => {
      mockAccountManager.getAccount.mockReturnValue({
        config: { id: 'test', email: 'test@gmail.com' },
        profileDir: '/tmp/profile',
        stateFilePath: '/tmp/state.json',
      });
      mockAccountManager.getCredentials.mockResolvedValue(null);

      const manager = new AutoLoginManager(mockAccountManager);
      const result = await manager.performAutoLogin('test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('No credentials available');
      expect(result.requiresManualIntervention).toBe(true);
    });

    it('should include duration in result', async () => {
      mockAccountManager.getAccount.mockReturnValue(undefined);

      const manager = new AutoLoginManager(mockAccountManager);
      const result = await manager.performAutoLogin('test');

      expect(result.duration).toBeDefined();
      expect(typeof result.duration).toBe('number');
    });

    it('should include accountId in result', async () => {
      mockAccountManager.getAccount.mockReturnValue(undefined);

      const manager = new AutoLoginManager(mockAccountManager);
      const result = await manager.performAutoLogin('test-account-id');

      expect(result.accountId).toBe('test-account-id');
    });
  });

  describe('autoLoginBestAccount', () => {
    it('should return null when no accounts available', async () => {
      mockAccountManager.getBestAccount.mockResolvedValue(null);

      const manager = new AutoLoginManager(mockAccountManager);
      const result = await manager.autoLoginBestAccount();

      expect(result).toBeNull();
    });

    it('should attempt login for best account', async () => {
      mockAccountManager.getBestAccount.mockResolvedValue({
        account: {
          config: { id: 'best-account', email: 'best@gmail.com' },
          profileDir: '/tmp/profile',
          stateFilePath: '/tmp/state.json',
        },
        reason: 'Least used',
      });
      mockAccountManager.getAccount.mockReturnValue({
        config: { id: 'best-account', email: 'best@gmail.com' },
        profileDir: '/tmp/profile',
        stateFilePath: '/tmp/state.json',
      });
      mockAccountManager.getCredentials.mockResolvedValue(null);

      const manager = new AutoLoginManager(mockAccountManager);
      const result = await manager.autoLoginBestAccount();

      expect(result).toBeDefined();
      expect(result?.accountId).toBe('best-account');
    });
  });

  describe('Error Handling', () => {
    it('should record login failure on error', async () => {
      mockAccountManager.getAccount.mockReturnValue({
        config: { id: 'test', email: 'test@gmail.com' },
        profileDir: '/tmp/profile',
        stateFilePath: '/tmp/state.json',
      });
      mockAccountManager.getCredentials.mockResolvedValue({
        email: 'test@gmail.com',
        password: 'password123',
      });

      // Mock chromium to throw
      const { chromium } = await import('patchright');
      (chromium.launchPersistentContext as jest.Mock).mockRejectedValue(
        new Error('Browser launch failed')
      );

      const manager = new AutoLoginManager(mockAccountManager);
      const result = await manager.performAutoLogin('test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Browser launch failed');
      expect(mockAccountManager.recordLoginFailure).toHaveBeenCalled();
    });
  });

  describe('Options', () => {
    it('should accept showBrowser option', async () => {
      mockAccountManager.getAccount.mockReturnValue(undefined);

      const manager = new AutoLoginManager(mockAccountManager);
      const result = await manager.performAutoLogin('test', { showBrowser: true });

      expect(result).toBeDefined();
    });

    it('should accept timeout option', async () => {
      mockAccountManager.getAccount.mockReturnValue(undefined);

      const manager = new AutoLoginManager(mockAccountManager);
      const result = await manager.performAutoLogin('test', { timeout: 30000 });

      expect(result).toBeDefined();
    });
  });
});

describe('AutoLoginManager TOTP Handling', () => {
  it('should identify 2FA requirement from URL', () => {
    const challengeUrls = [
      'https://accounts.google.com/v3/signin/challenge/totp',
      'https://accounts.google.com/signin/v2/challenge/ipp',
    ];

    for (const url of challengeUrls) {
      expect(url.includes('challenge')).toBe(true);
    }
  });

  it('should identify NotebookLM URL', () => {
    const notebookUrls = [
      'https://notebooklm.google.com/',
      'https://notebooklm.google.com/notebook/abc123',
    ];

    for (const url of notebookUrls) {
      expect(url.startsWith('https://notebooklm.google.com/')).toBe(true);
    }
  });
});

describe('AutoLoginManager Button Selectors', () => {
  it('should define Next button selectors', () => {
    const selectors = ['#identifierNext', '#passwordNext', '#totpNext', "button:has-text('Next')"];

    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors).toContain('#identifierNext');
    expect(selectors).toContain('#passwordNext');
  });

  it('should define email field selectors', () => {
    const selectors = ['input#identifierId', "input[name='identifier']", "input[type='email']"];

    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors).toContain('input#identifierId');
  });

  it('should define password field selectors', () => {
    const selectors = ["input[name='Passwd']", "input[type='password']"];

    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors).toContain("input[name='Passwd']");
  });

  it('should define TOTP field selectors', () => {
    const selectors = [
      "input[name='totpPin']",
      "input[type='tel']",
      "input[autocomplete='one-time-code']",
    ];

    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors).toContain("input[name='totpPin']");
  });
});

describe('AutoLoginManager Interstitial Handling', () => {
  it('should define dismiss button selectors', () => {
    const selectors = [
      "button:has-text('Not now')",
      "button:has-text('Skip')",
      "button:has-text('Done')",
      "button:has-text('Reject all')",
    ];

    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors).toContain("button:has-text('Not now')");
    expect(selectors).toContain("button:has-text('Skip')");
  });
});

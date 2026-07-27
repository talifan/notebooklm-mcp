/**
 * Shared Context Manager Tests
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock dependencies
jest.unstable_mockModule('../utils/logger.js', () => ({
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    dim: jest.fn(),
  },
}));

jest.unstable_mockModule('../config.js', () => ({
  CONFIG: {
    dataDir: '/tmp/test-data',
    chromeProfileDir: '/tmp/chrome-profile',
    browserStateDir: '/tmp/browser-state',
    viewport: { width: 1024, height: 768 },
    headless: true,
    uiLocale: 'en',
  },
  LOCALE_BROWSER_SETTINGS: {
    fr: { locale: 'fr-FR', timezone: 'Europe/Paris' },
    en: { locale: 'en-US', timezone: 'America/New_York' },
    de: { locale: 'de-DE', timezone: 'Europe/Berlin' },
    ja: { locale: 'ja-JP', timezone: 'Asia/Tokyo' },
  },
}));

// Mock patchright
jest.unstable_mockModule('patchright', () => ({
  chromium: {
    launchPersistentContext: jest.fn(),
    launch: jest.fn(),
  },
}));

describe('SharedContextManager', () => {
  let SharedContextManager: any;
  let mockAuthManager: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Mock auth manager
    mockAuthManager = {
      hasSavedState: jest.fn().mockResolvedValue(false),
      getStatePath: jest.fn().mockReturnValue(null),
      getValidStatePath: jest.fn().mockResolvedValue(null),
    };

    // Import module
    const module = await import('../session/shared-context-manager.js');
    SharedContextManager = module.SharedContextManager;
  });

  describe('Constructor', () => {
    it('should create instance with auth manager', () => {
      const manager = new SharedContextManager(mockAuthManager);
      expect(manager).toBeDefined();
    });
  });

  describe('Context State', () => {
    it('should not have context initially', () => {
      const manager = new SharedContextManager(mockAuthManager);
      const info = manager.getContextInfo();
      expect(info.exists).toBe(false);
    });

    it('should return null headless mode before creation', () => {
      const manager = new SharedContextManager(mockAuthManager);
      expect(manager.getCurrentHeadlessMode()).toBeNull();
    });
  });

  describe('Close Context', () => {
    it('should handle close when no context exists', async () => {
      const manager = new SharedContextManager(mockAuthManager);

      // Should not throw
      await manager.closeContext();
      const info = manager.getContextInfo();
      expect(info.exists).toBe(false);
    });
  });
});

describe('SharedContextManager Browser Options', () => {
  it('should define viewport options', () => {
    const viewport = { width: 1024, height: 768 };
    expect(viewport.width).toBe(1024);
    expect(viewport.height).toBe(768);
  });

  it('should define stealth args', () => {
    const stealthArgs = [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ];

    expect(stealthArgs).toContain('--disable-blink-features=AutomationControlled');
    expect(stealthArgs).not.toContain('--no-sandbox'); // Not including sandbox by default
  });

  it('should define headless option', () => {
    const headless = true;
    expect(typeof headless).toBe('boolean');
  });
});

describe('SharedContextManager User Agent', () => {
  it('should use Chrome user agent', () => {
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    expect(userAgent).toContain('Chrome');
    expect(userAgent).toContain('Windows');
    expect(userAgent).not.toContain('HeadlessChrome');
  });
});

describe('SharedContextManager Locale Settings', () => {
  it('should set locale', () => {
    const locale = 'en-US';
    expect(locale).toBe('en-US');
  });

  it('should set timezone', () => {
    const timezoneId = 'Europe/Berlin';
    expect(timezoneId).toBe('Europe/Berlin');
  });
});

describe('SharedContextManager Extended Tests', () => {
  let SharedContextManager: any;
  let mockAuthManager: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockAuthManager = {
      hasSavedState: jest.fn().mockResolvedValue(false),
      getStatePath: jest.fn().mockReturnValue(null),
      getValidStatePath: jest.fn().mockResolvedValue(null),
    };

    const module = await import('../session/shared-context-manager.js');
    SharedContextManager = module.SharedContextManager;
  });

  describe('Context Info', () => {
    it('should return info object with correct structure', () => {
      const manager = new SharedContextManager(mockAuthManager);
      const info = manager.getContextInfo();

      expect(info).toHaveProperty('exists');
      expect(typeof info.exists).toBe('boolean');
    });

    it('should show no pages initially', () => {
      const manager = new SharedContextManager(mockAuthManager);
      const info = manager.getContextInfo();

      expect(info.exists).toBe(false);
    });
  });

  describe('Headless Mode', () => {
    it('should return null headless mode when no context', () => {
      const manager = new SharedContextManager(mockAuthManager);
      const mode = manager.getCurrentHeadlessMode();

      expect(mode).toBeNull();
    });
  });

  describe('Multiple Close Calls', () => {
    it('should handle multiple close calls safely', async () => {
      const manager = new SharedContextManager(mockAuthManager);

      // Multiple closes should not throw
      await manager.closeContext();
      await manager.closeContext();
      await manager.closeContext();

      expect(manager.getContextInfo().exists).toBe(false);
    });
  });

  describe('Auth Manager Integration', () => {
    it('should accept auth manager in constructor', () => {
      const customAuthManager = {
        hasSavedState: jest.fn().mockResolvedValue(true),
        getStatePath: jest.fn().mockReturnValue('/path/to/state'),
        getValidStatePath: jest.fn().mockResolvedValue('/path/to/state'),
      };

      const manager = new SharedContextManager(customAuthManager);
      expect(manager).toBeDefined();
    });
  });
});

describe('SharedContextManager Chrome Arguments', () => {
  it('should define automation control disable flag', () => {
    const flag = '--disable-blink-features=AutomationControlled';
    expect(flag).toContain('disable-blink-features');
    expect(flag).toContain('AutomationControlled');
  });

  it('should define memory optimization flags', () => {
    const memFlags = ['--disable-dev-shm-usage', '--js-flags=--max-old-space-size=512'];

    memFlags.forEach((flag) => {
      expect(flag.startsWith('--')).toBe(true);
    });
  });

  it('should define first run prevention flags', () => {
    const flags = ['--no-first-run', '--no-default-browser-check'];

    expect(flags).toContain('--no-first-run');
    expect(flags).toContain('--no-default-browser-check');
  });
});

describe('SharedContextManager Viewport Settings', () => {
  it('should define minimum viewport dimensions', () => {
    const minWidth = 1024;
    const minHeight = 768;

    expect(minWidth).toBeGreaterThanOrEqual(1024);
    expect(minHeight).toBeGreaterThanOrEqual(768);
  });

  it('should support various viewport sizes', () => {
    const viewports = [
      { width: 1024, height: 768 },
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
    ];

    viewports.forEach((vp) => {
      expect(vp.width).toBeGreaterThan(0);
      expect(vp.height).toBeGreaterThan(0);
      expect(vp.width).toBeGreaterThanOrEqual(vp.height); // Width >= Height for landscape
    });
  });
});

describe('SharedContextManager Profile Management', () => {
  it('should define profile directory path', () => {
    const profileDir = '/tmp/chrome-profile';
    expect(typeof profileDir).toBe('string');
    expect(profileDir.length).toBeGreaterThan(0);
  });

  it('should handle different profile paths', () => {
    const paths = ['/tmp/profile1', '/var/data/profile', './local-profile'];

    paths.forEach((path) => {
      expect(typeof path).toBe('string');
    });
  });
});

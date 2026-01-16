import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { logger } from '../utils/logger';
import { Config } from '../utils/config';
import { SessionManager, SessionData } from './session';
import { WebhookReader } from '../email/webhookReader';
import { TelegramNotifier } from '../notifications/telegram';
import { randomSleep, sleep } from '../utils/helpers';

const SNCF_MAX_URL = 'https://www.maxjeune-tgvinoui.sncf/sncf-connect';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class Authenticator {
  private config: Config;
  private sessionManager: SessionManager;
  private webhookReader: WebhookReader;
  private telegram: TelegramNotifier;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(config: Config, telegram: TelegramNotifier) {
    this.config = config;
    this.sessionManager = new SessionManager(config.sessionPath);
    this.telegram = telegram;
    this.webhookReader = new WebhookReader(
      config.webhook.url,
      config.webhook.secret
    );
  }

  async initialize(): Promise<Page> {
    logger.info('Initializing browser...');

    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    // Try to restore session
    const savedSession = await this.sessionManager.loadSession();

    this.context = await this.browser.newContext({
      userAgent: savedSession?.userAgent || USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris'
    });

    // Restore cookies if we have a saved session
    if (savedSession?.cookies) {
      await this.context.addCookies(savedSession.cookies);
      logger.info('Restored cookies from saved session');
    }

    this.page = await this.context.newPage();

    // Add stealth scripts
    await this.page.addInitScript(() => {
      // Override webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });

      // Override plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });

      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['fr-FR', 'fr', 'en-US', 'en']
      });
    });

    return this.page;
  }

  async authenticate(): Promise<boolean> {
    if (!this.page) {
      await this.initialize();
    }

    const page = this.page!;

    try {
      // Navigate to MAX JEUNE page
      logger.info(`Navigating to ${SNCF_MAX_URL}`);
      await page.goto(SNCF_MAX_URL, { waitUntil: 'networkidle' });
      await randomSleep(2000, 4000);

      // Check if already logged in
      const isLoggedIn = await this.checkIfLoggedIn(page);

      if (isLoggedIn) {
        logger.info('Already logged in with existing session');
        return true;
      }

      logger.info('Not logged in, proceeding with authentication...');
      await this.telegram.notifyAuthRequired();

      // Click on login button
      await this.clickLoginButton(page);
      await randomSleep(2000, 3000);

      // Fill in credentials
      await this.fillCredentials(page);

      // Handle 2FA
      const twoFaRequired = await this.check2FARequired(page);

      if (twoFaRequired) {
        logger.info('2FA required, waiting for code from webhook...');
        const code = await this.webhookReader.waitForTwoFactorCode();
        await this.submit2FACode(page, code);
      }

      // Verify login success
      await page.waitForLoadState('networkidle');
      await randomSleep(2000, 3000);

      const loginSuccess = await this.checkIfLoggedIn(page);

      if (loginSuccess) {
        logger.info('Authentication successful');
        await this.saveCurrentSession();
        await this.telegram.notifyAuthSuccess();
        return true;
      }

      throw new Error('Login verification failed');

    } catch (error) {
      logger.error(`Authentication failed: ${error}`);
      await this.telegram.notifyAuthFailure(String(error));

      if (this.config.screenshotOnError) {
        await this.saveErrorScreenshot('auth_error');
      }

      return false;
    }
  }

  private async checkIfLoggedIn(page: Page): Promise<boolean> {
    try {
      // Look for elements that indicate we're logged in
      const loggedInIndicators = [
        'text="Mon espace MAX"',
        'text="Mes voyages"',
        'text="Déconnexion"',
        '[data-testid="user-menu"]',
        '.user-profile',
        'text="Bonjour"'
      ];

      for (const selector of loggedInIndicators) {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            return true;
          }
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private async clickLoginButton(page: Page): Promise<void> {
    const loginSelectors = [
      'text="Mon espace MAX"',
      'text="Se connecter"',
      'text="Connexion"',
      '[data-testid="login-button"]',
      'button:has-text("Connexion")',
      'a:has-text("Mon espace")'
    ];

    for (const selector of loginSelectors) {
      try {
        const button = await page.$(selector);
        if (button && await button.isVisible()) {
          await button.click();
          logger.info(`Clicked login button: ${selector}`);
          await page.waitForLoadState('networkidle');
          return;
        }
      } catch {
        continue;
      }
    }

    throw new Error('Could not find login button');
  }

  private async fillCredentials(page: Page): Promise<void> {
    logger.info('Filling in credentials...');

    // Wait for login form
    await page.waitForSelector('input[type="email"], input[name="email"], input[id="email"]', { timeout: 10000 });
    await randomSleep(500, 1000);

    // Find and fill email field
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[id="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="mail"]'
    ];

    for (const selector of emailSelectors) {
      const emailField = await page.$(selector);
      if (emailField && await emailField.isVisible()) {
        await emailField.click();
        await randomSleep(200, 400);
        await emailField.fill(this.config.sncf.email);
        logger.info('Email entered');
        break;
      }
    }

    await randomSleep(500, 1000);

    // Find and fill password field
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[id="password"]'
    ];

    for (const selector of passwordSelectors) {
      const passwordField = await page.$(selector);
      if (passwordField && await passwordField.isVisible()) {
        await passwordField.click();
        await randomSleep(200, 400);
        await passwordField.fill(this.config.sncf.password);
        logger.info('Password entered');
        break;
      }
    }

    await randomSleep(500, 1000);

    // Submit the form
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Connexion")',
      'button:has-text("Se connecter")',
      'input[type="submit"]'
    ];

    for (const selector of submitSelectors) {
      const submitButton = await page.$(selector);
      if (submitButton && await submitButton.isVisible()) {
        await submitButton.click();
        logger.info('Login form submitted');
        break;
      }
    }

    await page.waitForLoadState('networkidle');
  }

  private async check2FARequired(page: Page): Promise<boolean> {
    try {
      // Wait a bit for potential 2FA page
      await sleep(3000);

      // Look for 2FA input field or related text
      const twoFaIndicators = [
        'text="code de vérification"',
        'text="verification code"',
        'text="code à 6 chiffres"',
        'input[maxlength="6"]',
        'input[autocomplete="one-time-code"]',
        'text="envoyé par e-mail"',
        'text="sent to your email"'
      ];

      for (const selector of twoFaIndicators) {
        const element = await page.$(selector);
        if (element && await element.isVisible()) {
          logger.info('2FA verification required');
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private async submit2FACode(page: Page, code: string): Promise<void> {
    logger.info(`Entering 2FA code: ${code}`);

    // Find the 2FA input field
    const codeSelectors = [
      'input[maxlength="6"]',
      'input[autocomplete="one-time-code"]',
      'input[type="tel"]',
      'input[inputmode="numeric"]',
      'input[name="code"]'
    ];

    for (const selector of codeSelectors) {
      const codeField = await page.$(selector);
      if (codeField && await codeField.isVisible()) {
        await codeField.click();
        await randomSleep(200, 400);

        // Type the code digit by digit for more human-like behavior
        for (const digit of code) {
          await codeField.type(digit, { delay: 100 + Math.random() * 100 });
        }

        logger.info('2FA code entered');
        break;
      }
    }

    await randomSleep(500, 1000);

    // Submit the 2FA form
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Valider")',
      'button:has-text("Confirmer")',
      'button:has-text("Vérifier")'
    ];

    for (const selector of submitSelectors) {
      const submitButton = await page.$(selector);
      if (submitButton && await submitButton.isVisible()) {
        await submitButton.click();
        logger.info('2FA form submitted');
        break;
      }
    }

    await page.waitForLoadState('networkidle');
  }

  private async saveCurrentSession(): Promise<void> {
    if (!this.context || !this.page) return;

    const cookies = await this.context.cookies();

    // Get localStorage
    const localStorage = await this.page.evaluate(() => {
      const items: Record<string, string> = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key) {
          items[key] = window.localStorage.getItem(key) || '';
        }
      }
      return items;
    });

    const sessionData: SessionData = {
      cookies,
      localStorage,
      lastLogin: new Date().toISOString(),
      userAgent: USER_AGENT
    };

    await this.sessionManager.saveSession(sessionData);
  }

  private async saveErrorScreenshot(prefix: string): Promise<void> {
    if (!this.page) return;

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = `./data/screenshots/${prefix}_${timestamp}.png`;

      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info(`Screenshot saved: ${screenshotPath}`);
    } catch (error) {
      logger.error(`Failed to save screenshot: ${error}`);
    }
  }

  getPage(): Page | null {
    return this.page;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}

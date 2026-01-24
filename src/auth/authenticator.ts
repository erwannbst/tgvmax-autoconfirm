import { Camoufox } from 'camoufox-js';
import { Browser, BrowserContext, Page } from 'playwright';
import { logger } from '../utils/logger';
import { Config } from '../utils/config';
import { SessionManager, SessionData } from './session';
import { WebhookReader } from '../email/webhookReader';
import { TelegramNotifier } from '../notifications/telegram';
import { randomSleep, sleep } from '../utils/helpers';

const SNCF_MAX_URL = 'https://www.maxjeune-tgvinoui.sncf/sncf-connect';

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
    logger.info('Initializing browser with Camoufox (anti-detect Firefox)...');

    // Try to restore session
    const savedSession = await this.sessionManager.loadSession();

    // Build Camoufox options
    const camoufoxOptions: Parameters<typeof Camoufox>[0] = {
      headless: this.config.headless,
      // Configure fingerprint to use a modern Firefox version
      config: {
        'navigator.userAgent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
        'navigator.appVersion': '5.0 (Windows)',
        'navigator.platform': 'Win32'
      }
    };

    // Add proxy if configured
    if (this.config.proxyUrl) {
      logger.info('Using proxy for browser connections');
      camoufoxOptions.proxy = { server: this.config.proxyUrl };
    }

    // Launch Camoufox - it returns a browser instance with anti-detect built in
    this.browser = await Camoufox(camoufoxOptions) as Browser;

    // Create a new context with French locale
    this.context = await this.browser.newContext({
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

    // No stealth scripts needed - Camoufox handles all anti-detection internally
    // It patches Firefox at a low level, making detection nearly impossible

    return this.page;
  }

  async authenticate(): Promise<boolean> {
    if (!this.page) {
      await this.initialize();
    }

    const page = this.page!;

    // Load saved session for localStorage restoration
    const savedSession = await this.sessionManager.loadSession();

    try {
      // Navigate to MAX JEUNE page
      logger.info(`Navigating to ${SNCF_MAX_URL}`);
      await page.goto(SNCF_MAX_URL, { waitUntil: 'load', timeout: 30000 });
      // Wait for page to stabilize
      await randomSleep(2000, 3000);

      // Restore localStorage if we have saved session data
      if (savedSession?.localStorage && Object.keys(savedSession.localStorage).length > 0) {
        await page.evaluate((storage) => {
          for (const [key, value] of Object.entries(storage)) {
            localStorage.setItem(key, value);
          }
        }, savedSession.localStorage);
        logger.info('Restored localStorage from saved session');

        // Reload to apply localStorage - use 'load' instead of 'networkidle' to avoid timeout
        // on sites with continuous network activity
        try {
          await page.reload({ waitUntil: 'load', timeout: 15000 });
          // Wait a bit more for JS to process
          await randomSleep(2000, 3000);
        } catch (reloadError) {
          logger.warn(`Page reload timed out, continuing anyway: ${reloadError}`);
          // Continue anyway - the localStorage is already set
        }
      }

      await randomSleep(2000, 4000);

      // Handle cookie consent modal if present
      await this.handleCookieConsent(page);

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

      // Sometimes, the session is restored at this point, so we need to check if we are logged in
      const isLoggedIn2 = await this.checkIfLoggedIn(page);
      if (isLoggedIn2) {
        logger.info('Already logged in');
        return true;
      }

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

  private async handleCookieConsent(page: Page): Promise<void> {
    try {
      // Look for cookie consent modal and accept it
      const cookieSelectors = [
        'button:has-text("Accepter & Fermer")',
        'button:has-text("Accepter")',
        'text="Accepter & Fermer"',
        'text="Continuer sans accepter"',
        '[data-testid="accept-cookies"]',
        'button:has-text("Tout accepter")'
      ];

      for (const selector of cookieSelectors) {
        try {
          const button = await page.$(selector);
          if (button && await button.isVisible()) {
            await randomSleep(500, 1000);
            await button.click();
            logger.info(`Cookie consent handled: ${selector}`);
            await randomSleep(1000, 2000);
            return;
          }
        } catch {
          continue;
        }
      }

      logger.info('No cookie consent modal found or already accepted');
    } catch (error) {
      logger.warn(`Cookie consent handling failed: ${error}`);
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
        'text="Mes réservations à venir"'
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
      'text="Me connecter"',
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

    await randomSleep(600, 1200);
    // Submit the form
    const submitEmailSelectors = [
      'button[type="submit"]',
      'button:has-text("Connexion")',
      'button:has-text("Se connecter")',
      'input[type="submit"]'
    ];

    for (const selector of submitEmailSelectors) {
      const submitEmailButton = await page.$(selector);
      if (submitEmailButton && await submitEmailButton.isVisible()) {
        await submitEmailButton.click();
        logger.info('Email submitted');
        break;
      }
    }

    await page.waitForLoadState('networkidle');

    await randomSleep(1500, 3000);

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

    // First, try to find 6 separate input fields (common pattern)
    const separateFieldSelectors = [
      'input[maxlength="1"]',
      'input[data-index]',
      '.otp-input input',
      '.code-input input',
      '.verification-code input'
    ];

    for (const selector of separateFieldSelectors) {
      const fields = await page.$$(selector);
      const visibleFields = [];

      for (const field of fields) {
        if (await field.isVisible()) {
          visibleFields.push(field);
        }
      }

      if (visibleFields.length >= 6) {
        logger.info(`Found ${visibleFields.length} separate digit fields`);

        // Fill each field with corresponding digit
        for (let i = 0; i < Math.min(6, visibleFields.length); i++) {
          await visibleFields[i].click();
          await randomSleep(100, 200);
          await visibleFields[i].fill(code[i]);
          await randomSleep(100, 200);
        }

        logger.info('2FA code entered (separate fields)');
        await randomSleep(500, 1000);
        return this.submit2FAForm(page);
      }
    }

    // Fallback: single input field
    const singleFieldSelectors = [
      'input[maxlength="6"]',
      'input[autocomplete="one-time-code"]',
      'input[type="tel"]',
      'input[inputmode="numeric"]',
      'input[name="code"]'
    ];

    for (const selector of singleFieldSelectors) {
      const codeField = await page.$(selector);
      if (codeField && await codeField.isVisible()) {
        await codeField.click();
        await randomSleep(200, 400);

        // Type the full code
        await codeField.fill(code);

        logger.info('2FA code entered (single field)');
        break;
      }
    }

    await this.submit2FAForm(page);
  }

  private async submit2FAForm(page: Page): Promise<void> {
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

    // Get the user agent from the page (Camoufox generates a realistic one)
    const userAgent = await this.page.evaluate(() => navigator.userAgent);

    const sessionData: SessionData = {
      cookies,
      localStorage,
      lastLogin: new Date().toISOString(),
      userAgent
    };

    await this.sessionManager.saveSession(sessionData);
  }

  private async saveErrorScreenshot(prefix: string): Promise<string | null> {
    if (!this.page) return null;

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = `./data/screenshots/${prefix}_${timestamp}.png`;

      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info(`Screenshot saved: ${screenshotPath}`);

      // Send screenshot via Telegram
      await this.telegram.sendScreenshot(screenshotPath, `🚨 Error: ${prefix}`);

      return screenshotPath;
    } catch (error) {
      logger.error(`Failed to save screenshot: ${error}`);
      return null;
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

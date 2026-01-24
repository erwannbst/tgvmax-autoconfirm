import { loadConfig, Config, SncfAccount, getSessionPath } from './utils/config';
import { logger } from './utils/logger';
import { Authenticator } from './auth/authenticator';
import { ReservationConfirmer } from './confirmation/confirmer';
import { TelegramCommandBot } from './notifications/bot';
import { TelegramNotifier, AccountResult } from './notifications/telegram';
import fs from 'fs/promises';
import path from 'path';

let commandBot: TelegramCommandBot | null = null;

async function ensureDirectories(config: Config): Promise<void> {
  const dirs = [
    config.dataDir,
    path.join(config.dataDir, 'screenshots')
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

/**
 * Process a single account - authenticate and confirm reservations
 */
async function processAccount(
  config: Config,
  account: SncfAccount,
  telegram: TelegramNotifier,
  checkOnly: boolean = false
): Promise<AccountResult> {
  const sessionPath = getSessionPath(config, account.name);
  const authenticator = new Authenticator(config, account, sessionPath, telegram);

  const result: AccountResult = {
    accountName: account.name,
    confirmed: 0,
    failed: 0,
    skipped: 0,
  };

  try {
    logger.info(`[${account.name}] Starting processing...`);

    const authSuccess = await authenticator.authenticate();
    if (!authSuccess) {
      throw new Error('Authentication failed');
    }

    const page = authenticator.getPage();
    if (!page) {
      throw new Error('No page available');
    }

    if (checkOnly) {
      // Check-only mode: just fetch and display reservations
      const { ReservationScraper } = await import('./confirmation/scraper');
      const scraper = new ReservationScraper(page, telegram);
      const reservations = await scraper.fetchPendingReservations();
      await telegram.notifyReservationsFound(account.name, reservations);
    } else {
      // Confirmation mode
      const confirmer = new ReservationConfirmer(page, telegram, config, account.name);
      const results = await confirmer.run();

      // Aggregate results
      result.confirmed = results.filter(r => r.success).length;
      result.failed = results.filter(r => !r.success && !r.skipped).length;
      result.skipped = results.filter(r => r.skipped).length;
    }

    logger.info(`[${account.name}] Processing complete`);

  } catch (error) {
    logger.error(`[${account.name}] Error: ${error}`);
    await telegram.notifyError(String(error), account.name);
    result.failed = 1;
  } finally {
    await authenticator.close();
  }

  return result;
}

/**
 * Run confirmation for all accounts
 */
async function runConfirmationAllAccounts(config: Config, telegram: TelegramNotifier): Promise<AccountResult[]> {
  logger.info(`Running confirmation for ${config.accounts.length} account(s)...`);
  await telegram.notifyStartup();

  const results: AccountResult[] = [];

  for (const account of config.accounts) {
    const result = await processAccount(config, account, telegram, false);
    results.push(result);
  }

  // Send combined summary
  await telegram.notifyAllComplete(results);

  return results;
}

/**
 * Run check-only for all accounts
 */
async function runCheckAllAccounts(config: Config, telegram: TelegramNotifier): Promise<void> {
  logger.info(`Checking reservations for ${config.accounts.length} account(s)...`);

  for (const account of config.accounts) {
    await processAccount(config, account, telegram, true);
  }
}

/**
 * Run in always-on bot mode with scheduler
 */
async function runBotMode(config: Config): Promise<void> {
  logger.info('Starting TGV Max Auto-Confirm Bot...');

  commandBot = new TelegramCommandBot(config);
  const telegram = commandBot.getNotifier();

  // Set up handlers
  commandBot.setHandlers(
    // Confirm handler
    async () => {
      await runConfirmationAllAccounts(config, telegram);
    },
    // Check handler
    async () => {
      await runCheckAllAccounts(config, telegram);
    }
  );

  // Start the scheduler
  commandBot.startScheduler();

  // Notify startup with account names
  const accountNames = config.accounts.map(a => a.name).join(', ');
  await telegram.sendMessage(
    `🤖 <b>Bot started!</b>\n\n` +
    `👥 Accounts: ${accountNames}\n` +
    `⏰ Schedule: Daily at ${config.schedule.time}\n\n` +
    `Send /help for commands.`
  );

  logger.info('Bot is running. Press Ctrl+C to stop.');

  // Handle graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    if (commandBot) {
      await commandBot.stop();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Run in one-shot mode (for cron or manual trigger)
 */
async function runOneShotMode(config: Config, checkOnly: boolean): Promise<void> {
  const telegram = new TelegramNotifier(config.telegram);

  if (checkOnly) {
    await runCheckAllAccounts(config, telegram);
  } else {
    await runConfirmationAllAccounts(config, telegram);
  }
}

function printUsage(): void {
  console.log(`
TGV Max Auto-Confirm (Multi-Account)

Usage:
  npm start                 Run in bot mode (default, always-on with scheduler)
  npm start -- --bot        Run in bot mode (explicit)
  npm start -- --once       Run confirmation once and exit (for cron)
  npm start -- --check      Check reservations only (no confirmation, exits)
  npm start -- --help       Show this help

Bot Mode:
  The bot runs continuously, listening for Telegram commands and
  running scheduled confirmations daily for all configured accounts.

  Commands:
    /confirm  - Manually trigger confirmation for all accounts
    /check    - Check reservations without confirming
    /status   - Show bot status
    /help     - Show available commands

Environment variables:
  SNCF_ACCOUNTS       JSON array of accounts: [{"name":"X","email":"...","password":"..."}]
  WEBHOOK_URL         Google Apps Script webhook URL
  WEBHOOK_SECRET      Webhook secret key
  TELEGRAM_BOT_TOKEN  Telegram bot token
  TELEGRAM_CHAT_ID    Your Telegram chat ID = user ID
  SCHEDULE_ENABLED    Enable daily scheduler (default: true)
  SCHEDULE_TIME       Daily run time in HH:MM (default: 08:00)
  HEADLESS            Run browser headless (default: true)
  SCREENSHOT_ON_ERROR Save screenshot on error (default: true)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  try {
    const config = loadConfig();
    await ensureDirectories(config);

    logger.info(`Loaded ${config.accounts.length} account(s): ${config.accounts.map(a => a.name).join(', ')}`);

    const onceMode = args.includes('--once');
    const checkOnly = args.includes('--check');
    const botMode = args.includes('--bot') || (!onceMode && !checkOnly);

    if (onceMode || checkOnly) {
      await runOneShotMode(config, checkOnly);
      logger.info('Done');
    } else if (botMode) {
      await runBotMode(config);
    }

  } catch (error) {
    logger.error(`Fatal error: ${error}`);
    process.exitCode = 1;
  }
}

main();

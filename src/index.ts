import { loadConfig, Config } from './utils/config';
import { logger } from './utils/logger';
import { Authenticator } from './auth/authenticator';
import { ReservationConfirmer } from './confirmation/confirmer';
import { TelegramCommandBot } from './notifications/bot';
import fs from 'fs/promises';
import path from 'path';

let commandBot: TelegramCommandBot | null = null;

async function ensureDirectories(): Promise<void> {
  const dirs = [
    path.join(process.cwd(), 'data'),
    path.join(process.cwd(), 'data', 'screenshots')
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

/**
 * Run check-only mode (no confirmations)
 */
async function runCheckOnly(config: Config, bot: TelegramCommandBot): Promise<void> {
  logger.info('Running check-only mode (no confirmations)');

  const telegram = bot.getNotifier();
  const authenticator = new Authenticator(config, telegram);

  try {
    const authSuccess = await authenticator.authenticate();
    if (!authSuccess) {
      throw new Error('Authentication failed');
    }

    const page = authenticator.getPage();
    if (!page) {
      throw new Error('No page available');
    }

    const { ReservationScraper } = await import('./confirmation/scraper');
    const scraper = new ReservationScraper(page, telegram);

    const reservations = await scraper.fetchPendingReservations();
    await telegram.notifyReservationsFound(reservations);

    logger.info(`Found ${reservations.length} reservations requiring confirmation`);
    reservations.forEach(r => {
      logger.info(`  - ${r.origin} → ${r.destination} on ${r.departureDate.toLocaleDateString('fr-FR')} at ${r.departureTime}`);
    });

  } finally {
    await authenticator.close();
  }
}

/**
 * Run confirmation mode
 */
async function runConfirmation(config: Config, bot: TelegramCommandBot): Promise<void> {
  logger.info('Running confirmation mode');

  const telegram = bot.getNotifier();
  const authenticator = new Authenticator(config, telegram);

  try {
    await telegram.notifyStartup();

    const authSuccess = await authenticator.authenticate();
    if (!authSuccess) {
      throw new Error('Authentication failed');
    }

    const page = authenticator.getPage();
    if (!page) {
      throw new Error('No page available');
    }

    const confirmer = new ReservationConfirmer(page, telegram, config);
    const results = await confirmer.run();

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;

    logger.info(`Confirmation complete: ${successful} succeeded, ${failed} failed, ${skipped} skipped`);

  } finally {
    await authenticator.close();
  }
}

/**
 * Run in one-shot mode (legacy mode for cron)
 */
async function runOneShotMode(config: Config, checkOnly: boolean): Promise<void> {
  const { TelegramNotifier } = await import('./notifications/telegram');
  const telegram = new TelegramNotifier(config.telegram);
  const authenticator = new Authenticator(config, telegram);

  try {
    if (checkOnly) {
      logger.info('Running check-only mode');
      const { ReservationScraper } = await import('./confirmation/scraper');
      
      const authSuccess = await authenticator.authenticate();
      if (!authSuccess) throw new Error('Authentication failed');

      const page = authenticator.getPage();
      if (!page) throw new Error('No page available');

      const scraper = new ReservationScraper(page, telegram);
      const reservations = await scraper.fetchPendingReservations();
      await telegram.notifyReservationsFound(reservations);
    } else {
      logger.info('Running confirmation mode');
      await telegram.notifyStartup();

      const authSuccess = await authenticator.authenticate();
      if (!authSuccess) throw new Error('Authentication failed');

      const page = authenticator.getPage();
      if (!page) throw new Error('No page available');

      const confirmer = new ReservationConfirmer(page, telegram, config);
      await confirmer.run();
    }
  } finally {
    await authenticator.close();
  }
}

/**
 * Run in always-on bot mode with scheduler
 */
async function runBotMode(config: Config): Promise<void> {
  logger.info('Starting TGV Max Auto-Confirm Bot...');

  commandBot = new TelegramCommandBot(config);

  // Set up handlers
  commandBot.setHandlers(
    // Confirm handler
    async () => {
      await runConfirmation(config, commandBot!);
    },
    // Check handler
    async () => {
      await runCheckOnly(config, commandBot!);
    }
  );

  // Start the scheduler
  commandBot.startScheduler();

  // Notify startup
  await commandBot.getNotifier().sendMessage(
    `🤖 <b>Bot started!</b>\n\n` +
    `Schedule: Daily at ${config.schedule.time}\n` +
    `Send /help to see available commands.`
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

function printUsage(): void {
  console.log(`
TGV Max Auto-Confirm

Usage:
  npm start                 Run in bot mode (default, always-on with scheduler)
  npm start -- --bot        Run in bot mode (explicit)
  npm start -- --once       Run confirmation once and exit (for cron)
  npm start -- --check      Check reservations only (no confirmation, exits)
  npm start -- --help       Show this help

Bot Mode:
  The bot runs continuously, listening for Telegram commands and
  running scheduled confirmations daily.

  Commands:
    /confirm  - Manually trigger confirmation
    /check    - Check reservations without confirming
    /status   - Show bot status
    /help     - Show available commands

Environment variables:
  SNCF_EMAIL          Your SNCF account email
  SNCF_PASSWORD       Your SNCF account password
  WEBHOOK_URL         Google Apps Script webhook URL
  WEBHOOK_SECRET      Webhook secret key
  TELEGRAM_BOT_TOKEN  Telegram bot token
  TELEGRAM_CHAT_ID    Your Telegram chat ID
  TELEGRAM_USER_ID    Your Telegram user ID (for access control)
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
    await ensureDirectories();
    const config = loadConfig();

    const onceMode = args.includes('--once');
    const checkOnly = args.includes('--check');
    const botMode = args.includes('--bot') || (!onceMode && !checkOnly);

    if (onceMode || checkOnly) {
      // Legacy one-shot mode for cron
      await runOneShotMode(config, checkOnly);
      logger.info('Done');
    } else if (botMode) {
      // Always-on bot mode
      await runBotMode(config);
      // Bot keeps running, no exit
    }

  } catch (error) {
    logger.error(`Fatal error: ${error}`);
    process.exitCode = 1;
  }
}

main();

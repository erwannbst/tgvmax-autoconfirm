import { loadConfig, Config } from './utils/config';
import { logger } from './utils/logger';
import { Authenticator } from './auth/authenticator';
import { ReservationConfirmer } from './confirmation/confirmer';
import { TelegramNotifier } from './notifications/telegram';
import fs from 'fs/promises';
import path from 'path';

async function ensureDirectories(): Promise<void> {
  const dirs = [
    path.join(process.cwd(), 'data'),
    path.join(process.cwd(), 'data', 'screenshots')
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function runCheckOnly(config: Config): Promise<void> {
  logger.info('Running in check-only mode (no confirmations)');

  const telegram = new TelegramNotifier(config.telegram);
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

    const { ReservationScraper } = await import('./confirmation/scraper');
    const scraper = new ReservationScraper(page);

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

async function runConfirmation(config: Config): Promise<void> {
  logger.info('Running confirmation mode');

  const telegram = new TelegramNotifier(config.telegram);
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
    const failed = results.filter(r => !r.success).length;

    logger.info(`Confirmation complete: ${successful} succeeded, ${failed} failed`);

    if (failed > 0) {
      process.exitCode = 1;
    }

  } finally {
    await authenticator.close();
  }
}

function printUsage(): void {
  console.log(`
TGV Max Auto-Confirm

Usage:
  npm start                 Run confirmation (default)
  npm start -- --confirm    Run confirmation
  npm start -- --check      Check reservations only (no confirmation)
  npm start -- --help       Show this help

Environment variables:
  SNCF_EMAIL          Your SNCF account email
  SNCF_PASSWORD       Your SNCF account password
  WEBHOOK_URL         Google Apps Script webhook URL
  WEBHOOK_SECRET      Webhook secret key
  TELEGRAM_BOT_TOKEN  Telegram bot token
  TELEGRAM_CHAT_ID    Your Telegram chat ID
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

    const checkOnly = args.includes('--check');

    if (checkOnly) {
      await runCheckOnly(config);
    } else {
      await runConfirmation(config);
    }

    logger.info('Done');

  } catch (error) {
    logger.error(`Fatal error: ${error}`);
    process.exitCode = 1;
  }
}

main();

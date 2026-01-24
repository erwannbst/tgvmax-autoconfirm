import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../utils/logger';
import { Config, getAllowedUserIds, getAllChatIds } from '../utils/config';
import { TelegramNotifier } from './telegram';

export type ConfirmHandler = () => Promise<void>;
export type CheckHandler = () => Promise<void>;

interface BotState {
  isRunning: boolean;
  lastRun: Date | null;
  nextScheduledRun: Date | null;
}

export class TelegramCommandBot {
  private bot: TelegramBot;
  private config: Config;
  private notifier: TelegramNotifier;
  private allowedUserIds: string[];
  private state: BotState = {
    isRunning: false,
    lastRun: null,
    nextScheduledRun: null,
  };

  private confirmHandler?: ConfirmHandler;
  private checkHandler?: CheckHandler;
  private schedulerInterval?: NodeJS.Timeout;

  constructor(config: Config) {
    this.config = config;
    this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
    this.notifier = new TelegramNotifier(config.telegram.botToken, this.bot);
    this.allowedUserIds = getAllowedUserIds(config);

    this.setupCommands();
    this.setupErrorHandling();
  }

  /**
   * Get the notifier instance (for sending notifications)
   */
  getNotifier(): TelegramNotifier {
    return this.notifier;
  }

  /**
   * Register handlers for confirm and check operations
   */
  setHandlers(confirmHandler: ConfirmHandler, checkHandler: CheckHandler): void {
    this.confirmHandler = confirmHandler;
    this.checkHandler = checkHandler;
  }

  /**
   * Check if the user is authorized to use commands
   */
  private isAuthorized(userId: number | undefined): boolean {
    if (!userId) return false;
    return this.allowedUserIds.includes(userId.toString());
  }

  /**
   * Send unauthorized message
   */
  private async sendUnauthorized(chatId: number): Promise<void> {
    await this.bot.sendMessage(chatId, '⛔ Unauthorized. This bot is private.');
  }

  /**
   * Setup command handlers
   */
  private setupCommands(): void {
    // /start command
    this.bot.onText(/\/start/, async (msg) => {
      if (!this.isAuthorized(msg.from?.id)) {
        await this.sendUnauthorized(msg.chat.id);
        return;
      }

      const message = `🚄 <b>TGV Max Auto-Confirm Bot</b>\n\n` +
        `Available commands:\n` +
        `/confirm - Run confirmation now\n` +
        `/check - Check reservations (no confirm)\n` +
        `/status - Show bot status\n` +
        `/help - Show this help`;

      await this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    });

    // /help command
    this.bot.onText(/\/help/, async (msg) => {
      if (!this.isAuthorized(msg.from?.id)) {
        await this.sendUnauthorized(msg.chat.id);
        return;
      }

      const message = `🚄 <b>TGV Max Auto-Confirm Bot</b>\n\n` +
        `<b>Commands:</b>\n` +
        `/confirm - Manually trigger confirmation\n` +
        `/check - Check reservations without confirming\n` +
        `/status - Show bot and scheduler status\n` +
        `/help - Show this help message\n\n` +
        `<b>Scheduling:</b>\n` +
        `The bot automatically runs daily at ${this.config.schedule.time}`;

      await this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    });

    // /confirm command
    this.bot.onText(/\/confirm/, async (msg) => {
      if (!this.isAuthorized(msg.from?.id)) {
        await this.sendUnauthorized(msg.chat.id);
        return;
      }

      if (this.state.isRunning) {
        await this.bot.sendMessage(msg.chat.id, '⏳ A confirmation run is already in progress. Please wait.');
        return;
      }

      if (!this.confirmHandler) {
        await this.bot.sendMessage(msg.chat.id, '❌ Confirm handler not configured.');
        return;
      }

      await this.bot.sendMessage(msg.chat.id, '🚀 Starting confirmation run...');
      await this.runWithLock(this.confirmHandler);
    });

    // /check command
    this.bot.onText(/\/check/, async (msg) => {
      if (!this.isAuthorized(msg.from?.id)) {
        await this.sendUnauthorized(msg.chat.id);
        return;
      }

      if (this.state.isRunning) {
        await this.bot.sendMessage(msg.chat.id, '⏳ A run is already in progress. Please wait.');
        return;
      }

      if (!this.checkHandler) {
        await this.bot.sendMessage(msg.chat.id, '❌ Check handler not configured.');
        return;
      }

      await this.bot.sendMessage(msg.chat.id, '🔍 Checking reservations...');
      await this.runWithLock(this.checkHandler);
    });

    // /status command
    this.bot.onText(/\/status/, async (msg) => {
      if (!this.isAuthorized(msg.from?.id)) {
        await this.sendUnauthorized(msg.chat.id);
        return;
      }

      const status = this.state.isRunning ? '🟢 Running' : '🔵 Idle';
      const lastRun = this.state.lastRun
        ? this.state.lastRun.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })
        : 'Never';
      const nextRun = this.state.nextScheduledRun
        ? this.state.nextScheduledRun.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })
        : 'Not scheduled';

      const scheduleStatus = this.config.schedule.enabled ? '✅ Enabled' : '❌ Disabled';
      const accountNames = this.config.accounts.map(a => a.name).join(', ');

      const message = `📊 <b>Bot Status</b>\n\n` +
        `<b>Status:</b> ${status}\n` +
        `<b>Accounts:</b> ${accountNames}\n` +
        `<b>Last run:</b> ${lastRun}\n` +
        `<b>Next scheduled:</b> ${nextRun}\n\n` +
        `<b>Schedule:</b> ${scheduleStatus}\n` +
        `<b>Daily time:</b> ${this.config.schedule.time}`;

      await this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' });
    });

    logger.info('Telegram bot commands registered');
  }

  /**
   * Setup error handling for the bot
   */
  private setupErrorHandling(): void {
    this.bot.on('polling_error', (error) => {
      logger.error(`Telegram polling error: ${error.message}`);
    });

    this.bot.on('error', (error) => {
      logger.error(`Telegram bot error: ${error.message}`);
    });
  }

  /**
   * Run a handler with concurrency lock
   */
  private async runWithLock(handler: () => Promise<void>): Promise<void> {
    if (this.state.isRunning) {
      logger.warn('Attempted to run while already running');
      return;
    }

    this.state.isRunning = true;
    try {
      await handler();
      this.state.lastRun = new Date();
    } catch (error) {
      logger.error(`Handler error: ${error}`);
      // Broadcast error to all users
      const allChatIds = getAllChatIds(this.config);
      await this.notifier.broadcast(allChatIds, `🚨 Run failed: ${error}`);
    } finally {
      this.state.isRunning = false;
    }
  }

  /**
   * Start the scheduler for daily runs
   */
  startScheduler(): void {
    if (!this.config.schedule.enabled) {
      logger.info('Scheduler is disabled');
      return;
    }

    // Calculate next run time
    this.updateNextScheduledRun();

    // Check every minute if it's time to run
    this.schedulerInterval = setInterval(() => {
      this.checkAndRunScheduled();
    }, 60 * 1000); // Check every minute

    logger.info(`Scheduler started. Next run at ${this.state.nextScheduledRun?.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`);
  }

  /**
   * Update the next scheduled run time
   */
  private updateNextScheduledRun(): void {
    const [hours, minutes] = this.config.schedule.time.split(':').map(Number);
    const now = new Date();
    const next = new Date();

    next.setHours(hours, minutes, 0, 0);

    // If the time has passed today, schedule for tomorrow
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    this.state.nextScheduledRun = next;
  }

  /**
   * Check if it's time to run the scheduled task
   */
  private async checkAndRunScheduled(): Promise<void> {
    if (!this.state.nextScheduledRun || this.state.isRunning) {
      return;
    }

    const now = new Date();
    const scheduledTime = this.state.nextScheduledRun;

    // Check if we're within the minute of scheduled time
    if (now >= scheduledTime && now.getTime() - scheduledTime.getTime() < 60000) {
      logger.info('Running scheduled confirmation...');

      if (this.confirmHandler) {
        // Broadcast scheduled run start to all users
        const allChatIds = getAllChatIds(this.config);
        await this.notifier.broadcast(allChatIds, '⏰ <b>Scheduled run starting...</b>');
        await this.runWithLock(this.confirmHandler);
      }

      // Update next run for tomorrow
      this.updateNextScheduledRun();
      logger.info(`Next scheduled run: ${this.state.nextScheduledRun?.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`);
    }
  }

  /**
   * Stop the bot and scheduler
   */
  async stop(): Promise<void> {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
    }
    await this.bot.stopPolling();
    logger.info('Telegram bot stopped');
  }
}

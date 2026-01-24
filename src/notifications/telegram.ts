import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import { logger } from '../utils/logger';

export interface Reservation {
  id: string;
  origin: string;
  destination: string;
  departureDate: Date;
  departureTime: string;
  trainNumber: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  /** Whether the confirm button is enabled (false = too early to confirm) */
  confirmable: boolean;
}

export interface AccountResult {
  accountName: string;
  chatId: string;
  confirmed: number;
  failed: number;
  skipped: number;
}

export class TelegramNotifier {
  private bot: TelegramBot;

  /**
   * Create a TelegramNotifier
   * @param botToken Telegram bot token
   * @param existingBot Optional existing bot instance to reuse
   */
  constructor(botToken: string, existingBot?: TelegramBot) {
    this.bot = existingBot ?? new TelegramBot(botToken);
  }

  /**
   * Send a message to a specific chat
   */
  async sendMessage(chatId: string, message: string): Promise<void> {
    try {
      await this.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      logger.debug(`Telegram message sent to ${chatId}: ${message.substring(0, 50)}...`);
    } catch (error) {
      logger.error(`Failed to send Telegram message: ${error}`);
    }
  }

  /**
   * Broadcast a message to multiple chats
   */
  async broadcast(chatIds: string[], message: string): Promise<void> {
    const uniqueChatIds = [...new Set(chatIds)];
    for (const chatId of uniqueChatIds) {
      await this.sendMessage(chatId, message);
    }
  }

  async notifyReservationsFound(chatId: string, accountName: string, reservations: Reservation[]): Promise<void> {
    if (reservations.length === 0) {
      // No Telegram message if nothing found - just log
      logger.info(`[${accountName}] No reservations found`);
      return;
    }

    const lines = reservations.map(r => {
      const date = r.departureDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
      const status = r.confirmable ? '🟢' : '⏳';
      return `${status} ${r.origin} → ${r.destination} (${date} ${r.departureTime})`;
    });

    const message = `🔍 ${reservations.length} reservation(s):\n${lines.join('\n')}`;
    await this.sendMessage(chatId, message);
  }

  async notifyConfirmationSuccess(chatId: string, reservation: Reservation): Promise<void> {
    const date = reservation.departureDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    await this.sendMessage(chatId, `✅ ${reservation.origin} → ${reservation.destination} (${date} ${reservation.departureTime})`);
  }

  async notifyConfirmationFailure(chatId: string, reservation: Reservation, error: string): Promise<void> {
    const date = reservation.departureDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    await this.sendMessage(chatId, `❌ ${reservation.origin} → ${reservation.destination} (${date}): ${error}`);
  }

  async notifyAuthRequired(chatId: string): Promise<void> {
    // Logged server-side, no Telegram notification needed
    logger.info('Authentication required, waiting for 2FA...');
  }

  async notifyAuthSuccess(chatId: string): Promise<void> {
    // Logged server-side, no Telegram notification needed
    logger.info('Authenticated successfully');
  }

  async notifyAuthFailure(chatId: string, error: string): Promise<void> {
    // Auth failure is important - notify via Telegram
    await this.sendMessage(chatId, `❌ Auth failed: ${error}`);
  }

  async notifyError(chatId: string, error: string): Promise<void> {
    await this.sendMessage(chatId, `🚨 Error: ${error}`);
  }

  async sendScreenshot(chatId: string, screenshotPath: string, caption?: string): Promise<void> {
    try {
      if (!fs.existsSync(screenshotPath)) {
        logger.warn(`Screenshot file not found: ${screenshotPath}`);
        return;
      }

      await this.bot.sendPhoto(chatId, screenshotPath, {
        caption: caption || '📸 Error screenshot'
      });
      logger.info(`Screenshot sent via Telegram: ${screenshotPath}`);
    } catch (error) {
      logger.error(`Failed to send screenshot via Telegram: ${error}`);
    }
  }

  async notifyAccountComplete(chatId: string, result: AccountResult): Promise<void> {
    // Individual success/failure messages are already sent - only log summary
    logger.info(`[${result.accountName}] Complete: ${result.confirmed} confirmed, ${result.failed} failed, ${result.skipped} skipped`);
  }
}

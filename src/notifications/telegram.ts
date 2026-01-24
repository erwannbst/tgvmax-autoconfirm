import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import { logger } from '../utils/logger';
import { Config } from '../utils/config';

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

  async notifyStartup(chatId: string): Promise<void> {
    await this.sendMessage(chatId, '🚄 <b>TGV Max Auto-Confirm</b> started\n\nChecking reservations...');
  }

  async notifyReservationsFound(chatId: string, accountName: string, reservations: Reservation[]): Promise<void> {
    if (reservations.length === 0) {
      await this.sendMessage(chatId, `No reservations found.`);
      return;
    }

    const lines = reservations.map(r => {
      const date = r.departureDate.toLocaleDateString('fr-FR', {
        weekday: 'short',
        day: 'numeric',
        month: 'short'
      });
      const status = r.confirmable ? '🟢' : '⏳';
      const statusText = r.confirmable ? '' : ' (not yet)';
      return `${status} ${r.origin} → ${r.destination}${statusText}\n  📅 ${date} at ${r.departureTime}`;
    });

    const confirmableCount = reservations.filter(r => r.confirmable).length;
    const notYetCount = reservations.length - confirmableCount;

    let header = `🔍 Found ${reservations.length} reservation(s)`;
    if (notYetCount > 0 && confirmableCount > 0) {
      header += ` (${confirmableCount} ready, ${notYetCount} not yet)`;
    } else if (notYetCount > 0) {
      header += ` (not yet available)`;
    }

    const message = `${header}\n\n${lines.join('\n\n')}`;
    await this.sendMessage(chatId, message);
  }

  async notifyConfirmationSuccess(chatId: string, reservation: Reservation): Promise<void> {
    const date = reservation.departureDate.toLocaleDateString('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });

    const message = `✅ <b>Confirmed!</b>\n` +
      `🚄 ${reservation.origin} → ${reservation.destination}\n` +
      `📅 ${date} at ${reservation.departureTime}`;

    await this.sendMessage(chatId, message);
  }

  async notifyConfirmationFailure(chatId: string, reservation: Reservation, error: string): Promise<void> {
    const date = reservation.departureDate.toLocaleDateString('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });

    const message = `❌ <b>Failed!</b>\n` +
      `🚄 ${reservation.origin} → ${reservation.destination}\n` +
      `📅 ${date} at ${reservation.departureTime}\n` +
      `⚠️ ${error}`;

    await this.sendMessage(chatId, message);
  }

  async notifyAuthRequired(chatId: string): Promise<void> {
    await this.sendMessage(chatId,
      `🔐 <b>Authentication required</b>\n` +
      `Waiting for 2FA code...`
    );
  }

  async notifyAuthSuccess(chatId: string): Promise<void> {
    await this.sendMessage(chatId, `✅ Authenticated successfully`);
  }

  async notifyAuthFailure(chatId: string, error: string): Promise<void> {
    await this.sendMessage(chatId,
      `❌ <b>Authentication failed!</b>\n` +
      `Error: ${error}`
    );
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
    const parts = [];
    if (result.confirmed > 0) parts.push(`✅ ${result.confirmed} confirmed`);
    if (result.failed > 0) parts.push(`❌ ${result.failed} failed`);
    if (result.skipped > 0) parts.push(`⏳ ${result.skipped} not yet available`);

    if (parts.length === 0) {
      return; // No summary needed if nothing happened
    }

    const emoji = result.failed === 0 ? '✅' : '⚠️';
    const message = `${emoji} <b>Done!</b> ${parts.join(', ')}`;
    await this.sendMessage(chatId, message);
  }
}

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
  confirmed: number;
  failed: number;
  skipped: number;
}

export class TelegramNotifier {
  private bot: TelegramBot;
  private chatId: string;

  /**
   * Create a TelegramNotifier
   * @param config Telegram configuration
   * @param existingBot Optional existing bot instance to reuse (for sharing with command bot)
   */
  constructor(config: Pick<Config['telegram'], 'botToken' | 'chatId'>, existingBot?: TelegramBot) {
    this.bot = existingBot ?? new TelegramBot(config.botToken);
    this.chatId = config.chatId;
  }

  async sendMessage(message: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
      logger.debug(`Telegram message sent: ${message.substring(0, 50)}...`);
    } catch (error) {
      logger.error(`Failed to send Telegram message: ${error}`);
    }
  }

  async notifyStartup(): Promise<void> {
    await this.sendMessage('🚄 <b>TGV Max Auto-Confirm</b> started\n\nChecking for reservations to confirm...');
  }

  async notifyAccountStart(accountName: string): Promise<void> {
    await this.sendMessage(`\n👤 <b>[${accountName}]</b>`);
  }

  async notifyReservationsFound(accountName: string, reservations: Reservation[]): Promise<void> {
    if (reservations.length === 0) {
      await this.sendMessage(`👤 <b>[${accountName}]</b> No reservations found.`);
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

    let header = `👤 <b>[${accountName}]</b> Found ${reservations.length} reservation(s)`;
    if (notYetCount > 0 && confirmableCount > 0) {
      header += ` (${confirmableCount} ready, ${notYetCount} not yet)`;
    } else if (notYetCount > 0) {
      header += ` (not yet available)`;
    }

    const message = `${header}\n\n${lines.join('\n\n')}`;
    await this.sendMessage(message);
  }

  async notifyConfirmationSuccess(accountName: string, reservation: Reservation): Promise<void> {
    const date = reservation.departureDate.toLocaleDateString('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });

    const message = `✅ <b>[${accountName}]</b> Confirmed!\n` +
      `🚄 ${reservation.origin} → ${reservation.destination}\n` +
      `📅 ${date} at ${reservation.departureTime}`;

    await this.sendMessage(message);
  }

  async notifyConfirmationFailure(accountName: string, reservation: Reservation, error: string): Promise<void> {
    const date = reservation.departureDate.toLocaleDateString('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });

    const message = `❌ <b>[${accountName}]</b> Failed!\n` +
      `🚄 ${reservation.origin} → ${reservation.destination}\n` +
      `📅 ${date} at ${reservation.departureTime}\n` +
      `⚠️ ${error}`;

    await this.sendMessage(message);
  }

  async notifyAuthRequired(accountName: string): Promise<void> {
    await this.sendMessage(
      `🔐 <b>[${accountName}]</b> Authentication required\n` +
      `Waiting for 2FA code...`
    );
  }

  async notifyAuthSuccess(accountName: string): Promise<void> {
    await this.sendMessage(`✅ <b>[${accountName}]</b> Authenticated successfully`);
  }

  async notifyAuthFailure(accountName: string, error: string): Promise<void> {
    await this.sendMessage(
      `❌ <b>[${accountName}]</b> Authentication failed!\n` +
      `Error: ${error}`
    );
  }

  async notifyError(error: string, accountName?: string): Promise<void> {
    const prefix = accountName ? `<b>[${accountName}]</b> ` : '';
    await this.sendMessage(`🚨 ${prefix}Error: ${error}`);
  }

  async sendScreenshot(screenshotPath: string, caption?: string): Promise<void> {
    try {
      if (!fs.existsSync(screenshotPath)) {
        logger.warn(`Screenshot file not found: ${screenshotPath}`);
        return;
      }

      await this.bot.sendPhoto(this.chatId, screenshotPath, {
        caption: caption || '📸 Error screenshot'
      });
      logger.info(`Screenshot sent via Telegram: ${screenshotPath}`);
    } catch (error) {
      logger.error(`Failed to send screenshot via Telegram: ${error}`);
    }
  }

  async notifyAllComplete(results: AccountResult[]): Promise<void> {
    const totalConfirmed = results.reduce((sum, r) => sum + r.confirmed, 0);
    const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
    const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);

    const emoji = totalFailed === 0 ? '✅' : '⚠️';

    const accountLines = results.map(r => {
      const parts = [];
      if (r.confirmed > 0) parts.push(`✅ ${r.confirmed}`);
      if (r.failed > 0) parts.push(`❌ ${r.failed}`);
      if (r.skipped > 0) parts.push(`⏳ ${r.skipped}`);
      const summary = parts.length > 0 ? parts.join(' ') : 'No reservations';
      return `• <b>${r.accountName}</b>: ${summary}`;
    });

    let message = `${emoji} <b>Run complete</b>\n\n${accountLines.join('\n')}`;

    if (results.length > 1) {
      message += `\n\n<b>Total:</b> ✅ ${totalConfirmed} | ❌ ${totalFailed} | ⏳ ${totalSkipped}`;
    }

    await this.sendMessage(message);
  }
}

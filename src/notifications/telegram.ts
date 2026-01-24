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

  async notifyReservationsFound(reservations: Reservation[]): Promise<void> {
    if (reservations.length === 0) {
      await this.sendMessage('✅ No reservations requiring confirmation.');
      return;
    }

    const lines = reservations.map(r => {
      const date = r.departureDate.toLocaleDateString('fr-FR', {
        weekday: 'short',
        day: 'numeric',
        month: 'short'
      });
      const status = r.confirmable ? '🟢' : '⏳';
      const statusText = r.confirmable ? '' : ' (not yet available)';
      return `${status} ${r.origin} → ${r.destination}${statusText}\n  📅 ${date} at ${r.departureTime} (Train ${r.trainNumber})`;
    });

    const confirmableCount = reservations.filter(r => r.confirmable).length;
    const notYetCount = reservations.length - confirmableCount;
    
    let header = `🔍 <b>Found ${reservations.length} reservation(s):</b>`;
    if (notYetCount > 0) {
      header += `\n(${confirmableCount} ready to confirm, ${notYetCount} not yet available)`;
    }

    const message = `${header}\n\n${lines.join('\n\n')}`;
    await this.sendMessage(message);
  }

  async notifyConfirmationSuccess(reservation: Reservation): Promise<void> {
    const date = reservation.departureDate.toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });

    const message = `✅ <b>Reservation confirmed!</b>\n\n` +
      `🚄 ${reservation.origin} → ${reservation.destination}\n` +
      `📅 ${date} at ${reservation.departureTime}\n` +
      `🎫 Train ${reservation.trainNumber}`;

    await this.sendMessage(message);
  }

  async notifyConfirmationFailure(reservation: Reservation, error: string): Promise<void> {
    const date = reservation.departureDate.toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });

    const message = `❌ <b>Confirmation failed!</b>\n\n` +
      `🚄 ${reservation.origin} → ${reservation.destination}\n` +
      `📅 ${date} at ${reservation.departureTime}\n` +
      `🎫 Train ${reservation.trainNumber}\n\n` +
      `⚠️ Error: ${error}\n\n` +
      `<i>Please confirm manually on the SNCF app!</i>`;

    await this.sendMessage(message);
  }

  async notifyConfirmationNotYetAvailable(reservation: Reservation): Promise<void> {
    const date = reservation.departureDate.toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });

    const message = `⏳ <b>Confirmation not available yet</b>\n\n` +
      `🚄 ${reservation.origin} → ${reservation.destination}\n` +
      `📅 ${date} at ${reservation.departureTime}\n` +
      `🎫 Train ${reservation.trainNumber}\n\n` +
      `<i>The confirm button is disabled. This usually means it's too early to confirm (confirmation opens 48h before departure).</i>`;

    await this.sendMessage(message);
  }

  async notifyAuthRequired(): Promise<void> {
    await this.sendMessage(
      '🔐 <b>Authentication required</b>\n\n' +
      'The session has expired. Attempting to re-authenticate with 2FA...'
    );
  }

  async notifyAuthSuccess(): Promise<void> {
    await this.sendMessage('✅ Successfully authenticated to SNCF Connect.');
  }

  async notifyAuthFailure(error: string): Promise<void> {
    await this.sendMessage(
      `❌ <b>Authentication failed!</b>\n\n` +
      `Error: ${error}\n\n` +
      `<i>Please check your credentials and try again.</i>`
    );
  }

  async notifyError(error: string): Promise<void> {
    await this.sendMessage(`🚨 <b>Error:</b> ${error}`);
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

  async notifyComplete(confirmed: number, failed: number, skipped: number = 0): Promise<void> {
    const emoji = failed === 0 ? '✅' : '⚠️';
    let message = `${emoji} <b>Run complete</b>\n\n` +
      `✅ Confirmed: ${confirmed}\n` +
      `❌ Failed: ${failed}`;

    if (skipped > 0) {
      message += `\n⏳ Not yet available: ${skipped}`;
    }

    await this.sendMessage(message);
  }
}

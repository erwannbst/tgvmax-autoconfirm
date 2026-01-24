import { Page } from 'playwright';
import { logger } from '../utils/logger';
import { Reservation, TelegramNotifier } from '../notifications/telegram';
import { ReservationScraper } from './scraper';
import { randomSleep } from '../utils/helpers';
import { Config } from '../utils/config';
import fs from 'fs/promises';
import path from 'path';

export interface ConfirmationResult {
  reservation: Reservation;
  success: boolean;
  error?: string;
  skipped?: boolean; // True if skipped because confirmation not yet available
}

export class ReservationConfirmer {
  private page: Page;
  private scraper: ReservationScraper;
  private telegram: TelegramNotifier;
  private config: Config;
  private accountName: string;
  private chatId: string;

  constructor(page: Page, telegram: TelegramNotifier, config: Config, accountName: string, chatId: string) {
    this.page = page;
    this.scraper = new ReservationScraper(page);
    this.telegram = telegram;
    this.config = config;
    this.accountName = accountName;
    this.chatId = chatId;
  }

  async run(): Promise<ConfirmationResult[]> {
    const results: ConfirmationResult[] = [];

    try {
      // Fetch pending reservations
      const reservations = await this.scraper.fetchPendingReservations();

      await this.telegram.notifyReservationsFound(this.chatId, this.accountName, reservations);

      if (reservations.length === 0) {
        logger.info(`[${this.accountName}] No reservations found that need confirmation`);
        return results;
      }

      // Confirm each reservation
      for (const reservation of reservations) {
        const result = await this.confirmReservation(reservation);
        results.push(result);

        // Wait between confirmations
        if (reservations.indexOf(reservation) < reservations.length - 1) {
          await randomSleep(2000, 4000);
        }
      }

    } catch (error) {
      logger.error(`[${this.accountName}] Error during confirmation run: ${error}`);
      await this.telegram.notifyError(this.chatId, String(error));

      if (this.config.screenshotOnError) {
        await this.saveErrorScreenshot('confirmation_error');
      }
    }

    return results;
  }

  async confirmReservation(reservation: Reservation): Promise<ConfirmationResult> {
    logger.info(`Attempting to confirm: ${reservation.origin} → ${reservation.destination}`);

    // Check if confirmation is available (button not disabled)
    if (!reservation.confirmable) {
      logger.info(`Confirmation not yet available for: ${reservation.origin} → ${reservation.destination} (button disabled)`);
      return { reservation, success: false, skipped: true };
    }

    try {
      // Find the confirm button for this reservation
      const confirmButton = await this.scraper.getConfirmButtonForReservation(reservation);

      if (!confirmButton) {
        throw new Error('Could not find confirm button');
      }

      // Double-check if button is disabled (in case state changed)
      const isDisabled = await confirmButton.evaluate((el: HTMLButtonElement) => el.disabled);
      if (isDisabled) {
        logger.info(`Confirm button is disabled for: ${reservation.origin} → ${reservation.destination}`);
        return { reservation, success: false, skipped: true };
      }

      // Click the confirm button
      await confirmButton.click();
      logger.info('Clicked confirm button');

      // Handle the confirmation modal
      const dialogHandled = await this.handleConfirmationDialog();
      logger.info(`Dialog handling result: ${dialogHandled ? 'dialog found and clicked' : 'no dialog found'}`);

      // Wait for confirmation to process
      try {
        await this.page.waitForLoadState('networkidle', { timeout: 15000 });
      } catch {
        logger.warn('Network idle timeout, continuing anyway');
      }
      await randomSleep(2000, 3000);

      // Verify confirmation success
      const success = await this.verifyConfirmation(reservation);

      if (success) {
        logger.info(`[${this.accountName}] Successfully confirmed: ${reservation.origin} → ${reservation.destination}`);
        reservation.status = 'confirmed';
        await this.telegram.notifyConfirmationSuccess(this.chatId, reservation);
        return { reservation, success: true };
      } else {
        throw new Error('Confirmation verification failed');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[${this.accountName}] Failed to confirm reservation: ${errorMessage}`);
      await this.telegram.notifyConfirmationFailure(this.chatId, reservation, errorMessage);

      if (this.config.screenshotOnError) {
        await this.saveErrorScreenshot(`confirm_fail_${reservation.id}`);
      }

      return { reservation, success: false, error: errorMessage };
    }
  }

  private async handleConfirmationDialog(): Promise<boolean> {
    // Wait for the modal to appear
    const modalButtonSelector = 'button:has-text("Confirmer la réservation")';
    
    try {
      // Wait up to 5 seconds for the modal button to appear
      logger.info('Waiting for confirmation modal...');
      const modalButton = await this.page.waitForSelector(modalButtonSelector, { 
        state: 'visible', 
        timeout: 5000 
      });

      if (modalButton) {
        await randomSleep(500, 1000);
        await modalButton.click();
        logger.info('Clicked "Confirmer la réservation" in modal');
        
        // Wait for the confirmation to process
        try {
          await this.page.waitForLoadState('networkidle', { timeout: 30000 });
        } catch {
          logger.warn('Network idle timeout after modal click');
        }
        return true;
      }
    } catch (error) {
      logger.warn(`Modal button not found: ${error}`);
    }

    return false;
  }

  private async verifyConfirmation(reservation: Reservation): Promise<boolean> {
    logger.info('Verifying confirmation status...');

    // Check if the confirm button is still there and enabled
    const confirmButton = await this.scraper.getConfirmButtonForReservation(reservation);
    
    if (!confirmButton) {
      logger.info('Confirm button not found - success');
      return true;
    }

    const isVisible = await confirmButton.isVisible();
    if (!isVisible) {
      logger.info('Confirm button is no longer visible - success');
      return true;
    }

    const isDisabled = await confirmButton.evaluate((el: HTMLButtonElement) => el.disabled);
    if (isDisabled) {
      logger.info('Confirm button is now disabled - success');
      return true;
    }

    // Button is still visible and enabled - confirmation failed
    logger.warn('Confirm button is still enabled - confirmation failed');
    return false;
  }

  private async saveErrorScreenshot(prefix: string): Promise<void> {
    try {
      const screenshotDir = path.join(process.cwd(), 'data', 'screenshots');
      await fs.mkdir(screenshotDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = path.join(screenshotDir, `${prefix}_${timestamp}.png`);

      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info(`Screenshot saved: ${screenshotPath}`);

      // Send screenshot via Telegram
      await this.telegram.sendScreenshot(this.chatId, screenshotPath, `🚨 Error: ${prefix}`);
    } catch (error) {
      logger.error(`Failed to save screenshot: ${error}`);
    }
  }

}

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

  constructor(page: Page, telegram: TelegramNotifier, config: Config) {
    this.page = page;
    this.scraper = new ReservationScraper(page, telegram);
    this.telegram = telegram;
    this.config = config;
  }

  async run(): Promise<ConfirmationResult[]> {
    const results: ConfirmationResult[] = [];

    try {
      // Fetch pending reservations
      const reservations = await this.scraper.fetchPendingReservations();

      if (reservations.length === 0) {
        logger.info('No reservations found that need confirmation');
        await this.telegram.notifyReservationsFound([]);
        return results;
      }

      await this.telegram.notifyReservationsFound(reservations);

      // Confirm each reservation
      for (const reservation of reservations) {
        const result = await this.confirmReservation(reservation);
        results.push(result);

        // Wait between confirmations
        if (reservations.indexOf(reservation) < reservations.length - 1) {
          await randomSleep(2000, 4000);
        }
      }

      // Send summary
      const confirmed = results.filter(r => r.success).length;
      const skipped = results.filter(r => r.skipped).length;
      const failed = results.filter(r => !r.success && !r.skipped).length;
      await this.telegram.notifyComplete(confirmed, failed, skipped);

    } catch (error) {
      logger.error(`Error during confirmation run: ${error}`);
      await this.telegram.notifyError(String(error));

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

      await randomSleep(1000, 2000);

      // Handle potential confirmation dialog
      await this.handleConfirmationDialog();

      // Wait for confirmation to process
      await this.page.waitForLoadState('networkidle');
      await randomSleep(2000, 3000);

      // Verify confirmation success
      const success = await this.verifyConfirmation(reservation);

      if (success) {
        logger.info(`Successfully confirmed: ${reservation.origin} → ${reservation.destination}`);
        reservation.status = 'confirmed';
        await this.telegram.notifyConfirmationSuccess(reservation);
        return { reservation, success: true };
      } else {
        throw new Error('Confirmation verification failed');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to confirm reservation: ${errorMessage}`);
      await this.telegram.notifyConfirmationFailure(reservation, errorMessage);

      if (this.config.screenshotOnError) {
        await this.saveErrorScreenshot(`confirm_fail_${reservation.id}`);
      }

      return { reservation, success: false, error: errorMessage };
    }
  }

  private async handleConfirmationDialog(): Promise<void> {
    // Look for and handle any confirmation dialogs/modals
    const dialogSelectors = [
      'button:has-text("Oui")',
      'button:has-text("Confirmer")',
      'button:has-text("Valider")',
      'button:has-text("OK")',
      '[data-testid="confirm-dialog-yes"]',
      '.modal button:has-text("Confirm")'
    ];

    for (const selector of dialogSelectors) {
      try {
        const button = await this.page.$(selector);
        if (button && await button.isVisible()) {
          await randomSleep(500, 1000);
          await button.click();
          logger.info(`Clicked dialog button: ${selector}`);
          await this.page.waitForLoadState('networkidle');
          break;
        }
      } catch {
        continue;
      }
    }
  }

  private async verifyConfirmation(reservation: Reservation): Promise<boolean> {
    // Look for success indicators
    const successIndicators = [
      'text="Voyage confirmé"',
      'text="Confirmation réussie"',
      'text="Confirmé"',
      'text="Votre voyage est confirmé"',
      '.success-message',
      '[data-testid="confirmation-success"]'
    ];

    for (const selector of successIndicators) {
      try {
        const element = await this.page.$(selector);
        if (element && await element.isVisible()) {
          return true;
        }
      } catch {
        continue;
      }
    }

    // Also check if the confirm button is no longer visible (indicating it was processed)
    const confirmButton = await this.scraper.getConfirmButtonForReservation(reservation);
    if (!confirmButton || !(await confirmButton.isVisible())) {
      // Button disappeared, likely successful
      return true;
    }

    // Check page content for any error messages
    const errorIndicators = [
      'text="Erreur"',
      'text="Échec"',
      'text="impossible"',
      '.error-message'
    ];

    for (const selector of errorIndicators) {
      try {
        const element = await this.page.$(selector);
        if (element && await element.isVisible()) {
          return false;
        }
      } catch {
        continue;
      }
    }

    // If no clear success or failure, assume success if no errors
    return true;
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
      await this.telegram.sendScreenshot(screenshotPath, `🚨 Error: ${prefix}`);
    } catch (error) {
      logger.error(`Failed to save screenshot: ${error}`);
    }
  }
}

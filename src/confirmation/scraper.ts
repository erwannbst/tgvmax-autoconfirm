import { Page } from 'playwright';
import { logger } from '../utils/logger';
import { Reservation, TelegramNotifier } from '../notifications/telegram';
import { randomSleep } from '../utils/helpers';
import fs from 'fs/promises';
import path from 'path';

const MAX_ESPACE_URL = 'https://www.maxjeune-tgvinoui.sncf/sncf-connect/mes-voyages';

export class ReservationScraper {
  private page: Page;
  private telegram?: TelegramNotifier;

  constructor(page: Page, telegram?: TelegramNotifier) {
    this.page = page;
    this.telegram = telegram;
  }

  async navigateToReservations(): Promise<void> {
    logger.info('Navigating to reservations page...');

    // Try direct URL first
    await this.page.goto(MAX_ESPACE_URL, { waitUntil: 'networkidle' });
    await randomSleep(2000, 3000);

    // If redirected to login, we need to re-authenticate
    const currentUrl = this.page.url();
    if (currentUrl.includes('login') || currentUrl.includes('connexion')) {
      throw new Error('Session expired - redirected to login page');
    }

    // Look for and click on "Mes voyages" or similar tab
    const tabSelectors = [
      'text="Mes voyages"',
      'text="Mes réservations"',
      'text="Voyages à venir"',
      '[data-testid="trips-tab"]',
      'a:has-text("voyages")'
    ];

    for (const selector of tabSelectors) {
      try {
        const tab = await this.page.$(selector);
        if (tab && await tab.isVisible()) {
          await tab.click();
          await this.page.waitForLoadState('networkidle');
          await randomSleep(1000, 2000);
          logger.info(`Clicked on tab: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }
  }

  async fetchPendingReservations(): Promise<Reservation[]> {
    logger.info('Fetching pending reservations...');

    await this.navigateToReservations();

    const reservations: Reservation[] = [];

    // Wait for reservations to load
    await randomSleep(2000, 3000);

    // Try to find reservation cards/elements
    const reservationSelectors = [
      '.reservation-card',
      '.trip-card',
      '.voyage-item',
      '[data-testid="reservation-item"]',
      '.upcoming-trip',
      'article[class*="voyage"]',
      'div[class*="reservation"]'
    ];

    let reservationElements: any[] = [];

    for (const selector of reservationSelectors) {
      try {
        const elements = await this.page.$$(selector);
        if (elements.length > 0) {
          reservationElements = elements;
          logger.info(`Found ${elements.length} reservation elements with selector: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }

    // If no specific elements found, try to parse the page content
    if (reservationElements.length === 0) {
      logger.info('No specific reservation elements found, attempting to parse page content...');
      return await this.parsePageForReservations();
    }

    // Process each reservation element
    for (let i = 0; i < reservationElements.length; i++) {
      try {
        const reservation = await this.parseReservationElement(reservationElements[i], i);
        if (reservation && this.needsConfirmation(reservation)) {
          reservations.push(reservation);
        }
      } catch (error) {
        logger.warn(`Failed to parse reservation ${i}: ${error}`);
      }
    }

    logger.info(`Found ${reservations.length} reservations needing confirmation`);
    return reservations;
  }

  private async parseReservationElement(element: any, index: number): Promise<Reservation | null> {
    try {
      const text = await element.innerText();

      // Extract information using regex patterns
      const originDestMatch = text.match(/([A-ZÀ-Ü][a-zà-ü\-\s]+)\s*(?:→|->|>|vers)\s*([A-ZÀ-Ü][a-zà-ü\-\s]+)/i);
      const dateMatch = text.match(/(\d{1,2})\s*(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|jan|fév|mar|avr|mai|juin|juil|aoû|sep|oct|nov|déc)\.?\s*(\d{4})?/i);
      const timeMatch = text.match(/(\d{1,2})[h:](\d{2})/);
      const trainMatch = text.match(/(?:train|TGV|INOUI)\s*(?:n°|#)?\s*(\d+)/i);

      // Check for confirmation needed indicators
      const needsConfirmation = /confirmer|à confirmer|en attente|pending/i.test(text);

      if (!needsConfirmation) {
        return null;
      }

      const monthMap: Record<string, number> = {
        'janvier': 0, 'jan': 0,
        'février': 1, 'fév': 1,
        'mars': 2, 'mar': 2,
        'avril': 3, 'avr': 3,
        'mai': 4,
        'juin': 5,
        'juillet': 6, 'juil': 6,
        'août': 7, 'aoû': 7,
        'septembre': 8, 'sep': 8,
        'octobre': 9, 'oct': 9,
        'novembre': 10, 'nov': 10,
        'décembre': 11, 'déc': 11
      };

      let departureDate = new Date();
      if (dateMatch) {
        const day = parseInt(dateMatch[1]);
        const month = monthMap[dateMatch[2].toLowerCase()] ?? new Date().getMonth();
        const year = dateMatch[3] ? parseInt(dateMatch[3]) : new Date().getFullYear();
        departureDate = new Date(year, month, day);
      }

      return {
        id: `reservation-${index}-${Date.now()}`,
        origin: originDestMatch?.[1]?.trim() || 'Unknown',
        destination: originDestMatch?.[2]?.trim() || 'Unknown',
        departureDate,
        departureTime: timeMatch ? `${timeMatch[1]}h${timeMatch[2]}` : 'Unknown',
        trainNumber: trainMatch?.[1] || 'Unknown',
        status: 'pending',
        confirmable: true // Will be updated when checking the button state
      };
    } catch (error) {
      logger.error(`Error parsing reservation element: ${error}`);
      return null;
    }
  }

  private async parsePageForReservations(): Promise<Reservation[]> {
    const reservations: Reservation[] = [];

    try {
      // Find all "Confirmer" buttons (including disabled ones to see all upcoming trips)
      const confirmButtons = await this.page.$$('button:has-text("Confirmer")');

      logger.info(`Found ${confirmButtons.length} Confirmer buttons on page`);

      // Send screenshot as proof
      if (this.telegram) {
        await this.sendProofScreenshot('reservations_page');
      }

      for (let i = 0; i < confirmButtons.length; i++) {
        try {
          const button = confirmButtons[i];

          // Check if button is disabled
          const isDisabled = await button.evaluate((el: HTMLButtonElement) => el.disabled);

          // Extract reservation data from parent container
          const data = await button.evaluate((el: HTMLElement) => {
            // Go up the DOM to find the reservation container (look for section or large div)
            let container = el.parentElement;
            for (let j = 0; j < 15 && container; j++) {
              // Look for a container with enough content (stations, times, etc.)
              if (container.querySelectorAll('time').length >= 2) {
                break;
              }
              container = container.parentElement;
            }

            if (!container) return null;

            // Extract times from <time> elements
            const timeElements = container.querySelectorAll('time');
            const times: string[] = [];
            const datetimes: string[] = [];
            timeElements.forEach(t => {
              const text = t.textContent?.trim();
              const dt = t.getAttribute('datetime');
              // Time format is like "18:28" or has datetime attribute
              if (text && /^\d{1,2}[h:]\d{2}$/.test(text)) {
                times.push(text);
              }
              if (dt) {
                datetimes.push(dt);
              }
            });

            // Get all text content and look for station names (usually in ALL CAPS or with specific patterns)
            const allText = container.innerText;

            // Find station names - they appear after times, typically in uppercase
            // Pattern: time followed by station name
            const stationMatches = allText.match(/\d{1,2}[h:]\d{2}\s*\n?\s*([A-ZÀÂÄÉÈÊËÏÎÔÙÛÜÇ][A-ZÀÂÄÉÈÊËÏÎÔÙÛÜÇ\s\d]+)/g);
            const stations: string[] = [];
            if (stationMatches) {
              stationMatches.forEach(match => {
                const station = match.replace(/\d{1,2}[h:]\d{2}\s*\n?\s*/, '').trim();
                if (station.length > 2) {
                  stations.push(station);
                }
              });
            }

            // Extract train number (TGV INOUI N°8736 or similar)
            const trainMatch = allText.match(/(?:TGV|INOUI|INTERCITÉS?)\s*(?:INOUI\s*)?N°\s*(\d+)/i);
            const trainNumber = trainMatch ? trainMatch[1] : '';

            // Extract date - look for French date patterns
            const dateMatch = allText.match(/(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+(\d{4})/i);

            return {
              stations,
              times,
              datetimes,
              trainNumber,
              dateMatch: dateMatch ? { day: dateMatch[1], month: dateMatch[2], year: dateMatch[3] } : null,
              fullText: allText.substring(0, 500) // For debugging
            };
          });

          if (!data) {
            logger.warn(`Could not find container for button ${i}`);
            continue;
          }

          logger.info(`Button ${i} (disabled=${isDisabled}): stations=${data.stations.join(' → ')}, times=${data.times.join(', ')}, train=${data.trainNumber}`);

          // Parse the date
          let departureDate = new Date();
          if (data.datetimes.length > 0) {
            departureDate = new Date(data.datetimes[0]);
          } else if (data.dateMatch) {
            const monthMap: Record<string, number> = {
              'janvier': 0, 'février': 1, 'mars': 2, 'avril': 3,
              'mai': 4, 'juin': 5, 'juillet': 6, 'août': 7,
              'septembre': 8, 'octobre': 9, 'novembre': 10, 'décembre': 11
            };
            const day = parseInt(data.dateMatch.day);
            const month = monthMap[data.dateMatch.month.toLowerCase()];
            const year = parseInt(data.dateMatch.year);
            departureDate = new Date(year, month, day);
          }

          const origin = data.stations[0] || 'Unknown';
          const destination = data.stations[1] || 'Unknown';
          const departureTime = data.times[0] || 'Unknown';

          reservations.push({
            id: `reservation-${i}-${Date.now()}`,
            origin,
            destination,
            departureDate,
            departureTime,
            trainNumber: data.trainNumber || 'Unknown',
            status: 'pending',
            confirmable: !isDisabled
          });

          if (isDisabled) {
            logger.info(`Reservation ${origin} → ${destination} has disabled confirm button (too early to confirm)`);
          }

        } catch (error) {
          logger.warn(`Failed to parse reservation for button ${i}: ${error}`);
        }
      }

      if (confirmButtons.length === 0 && this.telegram) {
        await this.sendProofScreenshot('no_confirm_buttons');
      }
    } catch (error) {
      logger.error(`Error parsing page for reservations: ${error}`);
    }

    return reservations;
  }

  private parseTextForReservation(text: string, index: number): Reservation | null {
    const originDestMatch = text.match(/([A-ZÀ-Ü][a-zà-ü\-\s]+)\s*(?:→|->|>|vers)\s*([A-ZÀ-Ü][a-zà-ü\-\s]+)/i);
    const dateMatch = text.match(/(\d{1,2})\s*(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)/i);
    const timeMatch = text.match(/(\d{1,2})[h:](\d{2})/);
    const trainMatch = text.match(/(?:train|TGV|INOUI)\s*(?:n°|#)?\s*(\d+)/i);

    const monthMap: Record<string, number> = {
      'janvier': 0, 'février': 1, 'mars': 2, 'avril': 3,
      'mai': 4, 'juin': 5, 'juillet': 6, 'août': 7,
      'septembre': 8, 'octobre': 9, 'novembre': 10, 'décembre': 11
    };

    let departureDate = new Date();
    if (dateMatch) {
      const day = parseInt(dateMatch[1]);
      const month = monthMap[dateMatch[2].toLowerCase()];
      departureDate = new Date(new Date().getFullYear(), month, day);
    }

    return {
      id: `reservation-${index}-${Date.now()}`,
      origin: originDestMatch?.[1]?.trim() || 'Unknown',
      destination: originDestMatch?.[2]?.trim() || 'Unknown',
      departureDate,
      departureTime: timeMatch ? `${timeMatch[1]}h${timeMatch[2]}` : 'Unknown',
      trainNumber: trainMatch?.[1] || 'Unknown',
      status: 'pending',
      confirmable: true // Will be updated when checking the button state
    };
  }

  private needsConfirmation(reservation: Reservation): boolean {
    // Check if reservation is within the confirmation window (48h before departure)
    const now = new Date();
    const hoursUntilDeparture = (reservation.departureDate.getTime() - now.getTime()) / (1000 * 60 * 60);

    // Needs confirmation if departure is between 0 and 48 hours away
    return hoursUntilDeparture > 0 && hoursUntilDeparture <= 48;
  }

  async getConfirmButtonForReservation(reservation: Reservation): Promise<any | null> {
    // Find the confirm button associated with this reservation
    const confirmSelectors = [
      `button:has-text("Confirmer")`,
      `a:has-text("Confirmer")`,
      `[data-testid*="confirm"]`,
      `.confirm-button`,
      `button:has-text("Confirm")`
    ];

    for (const selector of confirmSelectors) {
      try {
        const buttons = await this.page.$$(selector);
        for (const button of buttons) {
          // Check if this button is near our reservation's info
          const isRelated = await button.evaluate((el: HTMLElement, resInfo: any) => {
            let parent = el.parentElement;
            for (let i = 0; i < 10 && parent; i++) {
              const text = parent.innerText.toLowerCase();
              if (text.includes(resInfo.origin.toLowerCase()) ||
                text.includes(resInfo.destination.toLowerCase())) {
                return true;
              }
              parent = parent.parentElement;
            }
            return false;
          }, { origin: reservation.origin, destination: reservation.destination });

          if (isRelated && await button.isVisible()) {
            return button;
          }
        }
      } catch {
        continue;
      }
    }

    // Fallback: return the first visible confirm button
    for (const selector of confirmSelectors) {
      const button = await this.page.$(selector);
      if (button && await button.isVisible()) {
        return button;
      }
    }

    return null;
  }

  private async sendProofScreenshot(prefix: string): Promise<void> {
    if (!this.telegram) return;

    try {
      const screenshotDir = path.join(process.cwd(), 'data', 'screenshots');
      await fs.mkdir(screenshotDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = path.join(screenshotDir, `${prefix}_${timestamp}.png`);

      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info(`Proof screenshot saved: ${screenshotPath}`);

      await this.telegram.sendScreenshot(screenshotPath, `📸 Page state: ${prefix}`);
    } catch (error) {
      logger.error(`Failed to send proof screenshot: ${error}`);
    }
  }
}

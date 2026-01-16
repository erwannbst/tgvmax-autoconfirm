import { Page } from 'playwright';
import { logger } from '../utils/logger';
import { Reservation } from '../notifications/telegram';
import { randomSleep } from '../utils/helpers';

const MAX_ESPACE_URL = 'https://www.maxjeune-tgvinoui.sncf/sncf-connect/espace-perso';

export class ReservationScraper {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
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
        status: 'pending'
      };
    } catch (error) {
      logger.error(`Error parsing reservation element: ${error}`);
      return null;
    }
  }

  private async parsePageForReservations(): Promise<Reservation[]> {
    const reservations: Reservation[] = [];

    try {
      // Get all text content and look for confirmation buttons
      const confirmButtons = await this.page.$$('button:has-text("Confirmer"), a:has-text("Confirmer"), [data-testid*="confirm"]');

      logger.info(`Found ${confirmButtons.length} confirm buttons on page`);

      for (let i = 0; i < confirmButtons.length; i++) {
        // Get parent container that might contain trip info
        const button = confirmButtons[i];
        const parentText = await button.evaluate((el: HTMLElement) => {
          // Look up the DOM tree for a container with trip info
          let parent = el.parentElement;
          for (let j = 0; j < 10 && parent; j++) {
            const text = parent.innerText;
            if (text.length > 50 && text.length < 1000) {
              return text;
            }
            parent = parent.parentElement;
          }
          return '';
        });

        if (parentText) {
          const reservation = this.parseTextForReservation(parentText, i);
          if (reservation) {
            reservations.push(reservation);
          }
        }
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
      status: 'pending'
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
}

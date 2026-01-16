import { logger } from '../utils/logger';
import { sleep } from '../utils/helpers';

interface WebhookResponse {
  success: boolean;
  code?: string;
  timestamp?: string;
  source?: string;
  error?: string;
}

export class WebhookReader {
  private webhookUrl: string;
  private secretKey: string;

  constructor(webhookUrl: string, secretKey: string) {
    this.webhookUrl = webhookUrl;
    this.secretKey = secretKey;
  }

  /**
   * Wait for and retrieve the 2FA code from the webhook
   */
  async waitForTwoFactorCode(maxWaitMs: number = 120000, pollIntervalMs: number = 5000): Promise<string> {
    const startTime = Date.now();

    logger.info('Waiting for 2FA code via webhook...');

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const code = await this.fetchCode();
        if (code) {
          logger.info(`Found 2FA code: ${code}`);
          // Clear the cache after retrieving
          await this.clearCache();
          return code;
        }
      } catch (error) {
        logger.warn(`Error fetching 2FA code: ${error}`);
      }

      await sleep(pollIntervalMs);
    }

    throw new Error(`Timeout waiting for 2FA code after ${maxWaitMs / 1000} seconds`);
  }

  private async fetchCode(): Promise<string | null> {
    const url = `${this.webhookUrl}?secret=${encodeURIComponent(this.secretKey)}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Webhook returned status ${response.status}`);
    }

    const data: WebhookResponse = await response.json();

    if (data.success && data.code) {
      return data.code;
    }

    return null;
  }

  private async clearCache(): Promise<void> {
    try {
      const url = `${this.webhookUrl}?secret=${encodeURIComponent(this.secretKey)}&action=clear`;
      await fetch(url, { method: 'POST' });
    } catch (error) {
      logger.warn(`Failed to clear webhook cache: ${error}`);
    }
  }
}

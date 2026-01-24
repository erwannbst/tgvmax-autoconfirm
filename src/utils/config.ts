import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface SncfAccount {
  name: string;
  email: string;
  password: string;
}

export interface Config {
  accounts: SncfAccount[];
  webhook: {
    url: string;
    secret: string;
  };
  telegram: {
    botToken: string;
    chatId: string;
    allowedUserId: string;
  };
  schedule: {
    enabled: boolean;
    time: string; // Time in HH:MM format (24h)
  };
  headless: boolean;
  screenshotOnError: boolean;
  dataDir: string;
  proxyUrl?: string;
}

function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function parseAccounts(): SncfAccount[] {
  const accountsJson = getEnvOrThrow('SNCF_ACCOUNTS');

  try {
    const accounts = JSON.parse(accountsJson) as SncfAccount[];

    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('SNCF_ACCOUNTS must be a non-empty array');
    }

    // Validate each account
    for (const account of accounts) {
      if (!account.name || !account.email || !account.password) {
        throw new Error(`Invalid account: each account must have name, email, and password`);
      }
    }

    return accounts;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`SNCF_ACCOUNTS is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

export function loadConfig(): Config {
  const accounts = parseAccounts();

  return {
    accounts,
    webhook: {
      url: getEnvOrThrow('WEBHOOK_URL'),
      secret: getEnvOrThrow('WEBHOOK_SECRET'),
    },
    telegram: {
      botToken: getEnvOrThrow('TELEGRAM_BOT_TOKEN'),
      chatId: getEnvOrThrow('TELEGRAM_CHAT_ID'),
      allowedUserId: getEnvOrThrow('TELEGRAM_CHAT_ID'),
    },
    schedule: {
      enabled: getEnvOrDefault('SCHEDULE_ENABLED', 'true') === 'true',
      time: getEnvOrDefault('SCHEDULE_TIME', '08:00'),
    },
    headless: getEnvOrDefault('HEADLESS', 'true') === 'true',
    screenshotOnError: getEnvOrDefault('SCREENSHOT_ON_ERROR', 'true') === 'true',
    dataDir: getEnvOrDefault('DATA_DIR', path.join(process.cwd(), 'data')),
    proxyUrl: process.env.PROXY_URL || undefined,
  };
}

/**
 * Get session file path for a specific account
 */
export function getSessionPath(config: Config, accountName: string): string {
  const safeName = accountName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return path.join(config.dataDir, `session-${safeName}.json`);
}

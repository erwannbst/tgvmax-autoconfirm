import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export interface Config {
  sncf: {
    email: string;
    password: string;
  };
  webhook: {
    url: string;
    secret: string;
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
  headless: boolean;
  screenshotOnError: boolean;
  sessionPath: string;
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

export function loadConfig(): Config {
  return {
    sncf: {
      email: getEnvOrThrow('SNCF_EMAIL'),
      password: getEnvOrThrow('SNCF_PASSWORD'),
    },
    webhook: {
      url: getEnvOrThrow('WEBHOOK_URL'),
      secret: getEnvOrThrow('WEBHOOK_SECRET'),
    },
    telegram: {
      botToken: getEnvOrThrow('TELEGRAM_BOT_TOKEN'),
      chatId: getEnvOrThrow('TELEGRAM_CHAT_ID'),
    },
    headless: getEnvOrDefault('HEADLESS', 'true') === 'true',
    screenshotOnError: getEnvOrDefault('SCREENSHOT_ON_ERROR', 'true') === 'true',
    sessionPath: getEnvOrDefault('SESSION_PATH', path.join(process.cwd(), 'data', 'session.json')),
  };
}

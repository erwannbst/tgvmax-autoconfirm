import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger';

export interface SessionData {
  cookies: any[];
  localStorage: Record<string, string>;
  lastLogin: string;
  userAgent: string;
}

export class SessionManager {
  private sessionPath: string;

  constructor(sessionPath: string) {
    this.sessionPath = sessionPath;
  }

  async saveSession(data: SessionData): Promise<void> {
    try {
      const dir = path.dirname(this.sessionPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.sessionPath, JSON.stringify(data, null, 2));
      logger.info('Session saved successfully');
    } catch (error) {
      logger.error(`Failed to save session: ${error}`);
      throw error;
    }
  }

  async loadSession(): Promise<SessionData | null> {
    try {
      const data = await fs.readFile(this.sessionPath, 'utf-8');
      const session = JSON.parse(data) as SessionData;

      // Check if session is too old (older than 7 days)
      const lastLogin = new Date(session.lastLogin);
      const daysSinceLogin = (Date.now() - lastLogin.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSinceLogin > 7) {
        logger.info('Session is older than 7 days, will require fresh login');
        return null;
      }

      logger.info(`Loaded session from ${session.lastLogin}`);
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No existing session found');
        return null;
      }
      logger.error(`Failed to load session: ${error}`);
      return null;
    }
  }

  async clearSession(): Promise<void> {
    try {
      await fs.unlink(this.sessionPath);
      logger.info('Session cleared');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error(`Failed to clear session: ${error}`);
      }
    }
  }
}

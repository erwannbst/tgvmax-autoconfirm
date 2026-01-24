/**
 * TGV Max 2FA Code Webhook
 *
 * This Google Apps Script monitors your Gmail for SNCF verification codes
 * and exposes them via a simple webhook endpoint.
 *
 * Setup:
 * 1. Go to https://script.google.com
 * 2. Create a new project
 * 3. Paste this code
 * 4. Deploy as Web App (Execute as: Me, Who has access: Anyone)
 * 5. Copy the deployment URL to your .env as WEBHOOK_URL
 * 6. Set a secret key in Script Properties: SECRET_KEY
 */

// Configuration
const CONFIG = {
  // How long to keep codes (milliseconds)
  CODE_TTL: 10 * 60 * 1000, // 10 minutes

  // Email search query - Mon Identifiant SNCF security codes
  SEARCH_QUERY: 'from:no-reply@monidentifiant.sncf subject:"Code de sécurité" newer_than:1h is:unread',
};

/**
 * GET endpoint - retrieve the latest 2FA code
 * Usage: GET {webhook_url}?secret={your_secret}
 */
function doGet(e) {
  const secret = e.parameter.secret;
  const storedSecret = PropertiesService.getScriptProperties().getProperty('SECRET_KEY');

  if (!storedSecret || secret !== storedSecret) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: 'Unauthorized'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // Check for stored code first
  const cachedCode = getCachedCode();
  if (cachedCode) {
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      code: cachedCode.code,
      timestamp: cachedCode.timestamp,
      source: 'cache'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // Search for new code in emails
  const code = searchForCode();
  if (code) {
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      code: code.code,
      timestamp: code.timestamp,
      source: 'email'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({
    success: false,
    error: 'No code found'
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Search Gmail for SNCF verification code
 * Always returns the code from the most recent email
 */
function searchForCode() {
  const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 10);

  // Collect all matching messages from all threads
  const allMessages = [];
  for (const thread of threads) {
    const messages = thread.getMessages();
    for (const message of messages) {
      // Only include unread messages
      if (!message.isUnread()) continue;
      allMessages.push(message);
    }
  }

  // Sort by date, newest first
  allMessages.sort((a, b) => b.getDate().getTime() - a.getDate().getTime());

  // Process messages from newest to oldest
  for (const message of allMessages) {
    // Try HTML body first (contains title attribute with full code)
    // Then fall back to plain text
    const htmlBody = message.getBody();
    const plainBody = message.getPlainBody();
    
    let code = null;
    
    // Try HTML body first (more reliable for this email format)
    if (htmlBody) {
      code = extractCode(htmlBody);
    }
    
    // Fall back to plain text if HTML didn't work
    if (!code && plainBody) {
      code = extractCode(plainBody);
    }

    if (code) {
      // Mark as read to avoid re-processing
      message.markRead();

      // Cache the code
      cacheCode(code, message.getDate().toISOString());

      return {
        code: code,
        timestamp: message.getDate().toISOString()
      };
    }
  }

  return null;
}

/**
 * Extract 6-digit code from email body
 * Handles Mon Identifiant SNCF email format where code appears as:
 * - title="Votre code de vérification est : 360858"
 * - <span>360</span><span>858</span> (split in HTML)
 */
function extractCode(body) {
  // Pattern 1: title attribute format (most reliable for HTML emails)
  // Matches: title="Votre code de vérification est : 360858"
  const titlePattern = /title\s*=\s*["'].*?code\s*(?:de\s*)?v[ée]rification\s*(?:est\s*)?:?\s*(\d{6})["']/i;
  const titleMatch = body.match(titlePattern);
  if (titleMatch && titleMatch[1]) {
    return titleMatch[1];
  }

  // Pattern 2: Code split in two spans with possible space/markup between
  // Matches: >360</span><span...>858< or similar patterns
  const splitCodePattern = />(\d{3})<\/span>\s*<span[^>]*>(\d{3})</i;
  const splitMatch = body.match(splitCodePattern);
  if (splitMatch && splitMatch[1] && splitMatch[2]) {
    return splitMatch[1] + splitMatch[2];
  }

  // Pattern 3: Standard verification code patterns
  const patterns = [
    /code\s*(?:de\s*)?v[ée]rification\s*(?:est\s*)?:?\s*(\d{6})/i,
    /code\s*(?:de\s*)?s[ée]curit[ée]\s*(?:est\s*)?:?\s*(\d{6})/i,
    /verification\s*code\s*:?\s*(\d{6})/i,
    /code\s*:?\s*(\d{6})/i,
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  // Pattern 4: Two 3-digit numbers separated by space (plain text rendering)
  // Matches: 360 858
  const spacedCodePattern = /\b(\d{3})\s+(\d{3})\b/;
  const spacedMatch = body.match(spacedCodePattern);
  if (spacedMatch && spacedMatch[1] && spacedMatch[2]) {
    return spacedMatch[1] + spacedMatch[2];
  }

  // Fallback: find any 6-digit number
  const fallbackMatch = body.match(/\b(\d{6})\b/);
  return fallbackMatch ? fallbackMatch[1] : null;
}

/**
 * Cache the code in Script Properties
 */
function cacheCode(code, timestamp) {
  const data = JSON.stringify({
    code: code,
    timestamp: timestamp,
    expires: Date.now() + CONFIG.CODE_TTL
  });
  PropertiesService.getScriptProperties().setProperty('CACHED_CODE', data);
}

/**
 * Get cached code if still valid
 */
function getCachedCode() {
  const data = PropertiesService.getScriptProperties().getProperty('CACHED_CODE');
  if (!data) return null;

  try {
    const parsed = JSON.parse(data);
    if (parsed.expires > Date.now()) {
      return parsed;
    }
    // Expired, clear it
    PropertiesService.getScriptProperties().deleteProperty('CACHED_CODE');
  } catch (e) {
    // Invalid data
  }

  return null;
}

/**
 * Clear the cached code (can be called manually or via webhook)
 */
function clearCache() {
  PropertiesService.getScriptProperties().deleteProperty('CACHED_CODE');
}

/**
 * POST endpoint - can be used to clear cache
 * Usage: POST {webhook_url}?secret={your_secret}&action=clear
 */
function doPost(e) {
  const secret = e.parameter.secret;
  const storedSecret = PropertiesService.getScriptProperties().getProperty('SECRET_KEY');

  if (!storedSecret || secret !== storedSecret) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: 'Unauthorized'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  const action = e.parameter.action;

  if (action === 'clear') {
    clearCache();
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      message: 'Cache cleared'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({
    success: false,
    error: 'Unknown action'
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Test function - run this to verify email search works
 */
function testSearch() {
  const code = searchForCode();
  Logger.log('Found code: ' + JSON.stringify(code));
}

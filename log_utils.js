const fs = require('fs');
const path = require('path');

/**
 * Logs a message to the bot.log file with a timestamp.
 * @param {string} message - The message to log.
 */
function logToFile(message) {
  try {
    const timestamp = new Date().toISOString();
    const sanitizedMessage = String(message).replace(/\n/g, '\\n');
    const logMessage = `[${timestamp}] ${sanitizedMessage}\n`;
    const logFilePath = path.join(__dirname, 'bot.log');
    fs.appendFileSync(logFilePath, logMessage);
  } catch (error) {
    console.error(`Fallback log (file logging failed: ${error.message}): ${message}`);
  }
}

/**
 * Format a Frame.io axios error into a human readable message.
 * @param {any} error - The error thrown by axios.
 * @param {string} action - Description of the action being performed.
 * @returns {string}
 */
function frameioErrorMessage(error, action) {
  if (error.response) {
    const status = error.response.status;
    if (status === 404) {
      return `${action} returned 404 Not Found. Check FRAMEIO_ACCOUNT_ID or FRAMEIO_ROOT_ASSET_ID.`;
    }
    if (status === 429) {
      return `${action} returned 429 Too Many Requests. The bot hit Frame.io rate limits.`;
    }
    return `${action} returned ${status} ${error.response.statusText}`;
  }
  return `${action} failed: ${error.message}`;
}

module.exports = { logToFile, frameioErrorMessage };

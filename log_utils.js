const fs = require('fs');
const path = require('path');

/**
 * Logs a message to the bot.log file with a timestamp.
 * @param {string} message - The message to log.
 */
function logToFile(message) {
  try {
    const timestamp = new Date().toISOString();
    // Sanitize message to prevent log injection if it comes from untrusted input
    const sanitizedMessage = String(message).replace(/\n/g, '\\n');
    const logMessage = `[${timestamp}] ${sanitizedMessage}\n`;
    const logFilePath = path.join(__dirname, 'bot.log');
    fs.appendFileSync(logFilePath, logMessage);
  } catch (error) {
    // Fallback to console if file logging fails
    console.error(`Fallback log (file logging failed: ${error.message}): ${message}`);
  }
}

module.exports = { logToFile }; 
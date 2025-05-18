// Utils module - Common utility functions for the Discord bot
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

/**
 * Calculate the time until the next execution of a cron expression
 * @param {string} cronExpression - Cron expression to calculate next execution for
 * @param {string} timezone - Optional timezone
 * @returns {Object} Object containing hours, minutes, seconds until next execution
 */
function getTimeUntilNextExecution(cronExpression, timezone) {
  try {
    // Get the current date/time
    const now = new Date();
    
    // Get the next execution date/time
    const nextDate = cron.schedule(cronExpression, () => {}, { timezone }).nextDate().toDate();
    
    // Calculate the difference in milliseconds
    const diffMs = nextDate - now;
    
    // Convert to hours, minutes, seconds
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
    
    return { hours, minutes, seconds, totalMs: diffMs };
  } catch (error) {
    console.error(`Error calculating next execution time: ${error.message}`);
    return { hours: 0, minutes: 0, seconds: 0, totalMs: 0 };
  }
}

/**
 * Format a duration in a human-readable format
 * @param {Object} duration - Duration object with hours, minutes, seconds
 * @returns {string} Formatted duration string
 */
function formatDuration(duration) {
  const parts = [];
  
  if (duration.hours > 0) {
    parts.push(`${duration.hours}h`);
  }
  
  if (duration.minutes > 0 || duration.hours > 0) {
    parts.push(`${duration.minutes}m`);
  }
  
  parts.push(`${duration.seconds}s`);
  
  return parts.join(' ');
}

/**
 * Log a message to a file with timestamp
 * @param {string} message - Message to log
 * @param {string} logFile - Path to log file (optional)
 */
function logToFile(message, logFile = 'bot.log') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Ensure logs directory exists
  const logsDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  
  // Append to log file
  fs.appendFileSync(path.join(logsDir, logFile), logMessage);
  
  // Also log to console
  console.log(message);
}

/**
 * Create an embed with standardized formatting
 * @param {Object} options - Embed options
 * @returns {Object} Discord embed object
 */
function createEmbed(options = {}) {
  const {
    title = '',
    description = '',
    color = 0x0099ff,
    fields = [],
    footer = null,
    thumbnail = null,
    timestamp = true
  } = options;
  
  const embed = {
    title,
    description,
    color,
    fields: fields.map(field => ({
      name: field.name,
      value: field.value,
      inline: field.inline || false
    }))
  };
  
  if (footer) {
    embed.footer = { text: footer };
  }
  
  if (thumbnail) {
    embed.thumbnail = { url: thumbnail };
  }
  
  if (timestamp) {
    embed.timestamp = new Date();
  }
  
  return embed;
}

/**
 * Safely read a JSON file with error handling
 * @param {string} filePath - Path to JSON file
 * @param {Object} defaultValue - Default value if file doesn't exist or is invalid
 * @returns {Object} Parsed JSON or default value
 */
function readJsonFile(filePath, defaultValue = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }
    
    const fileContent = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(fileContent);
  } catch (error) {
    logToFile(`Error reading JSON file ${filePath}: ${error.message}`);
    return defaultValue;
  }
}

/**
 * Safely write a JSON file with error handling
 * @param {string} filePath - Path to JSON file
 * @param {Object} data - Data to write
 * @param {boolean} pretty - Whether to pretty-print the JSON
 * @returns {boolean} Success status
 */
function writeJsonFile(filePath, data, pretty = true) {
  try {
    const jsonData = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(filePath, jsonData, 'utf8');
    return true;
  } catch (error) {
    logToFile(`Error writing JSON file ${filePath}: ${error.message}`);
    return false;
  }
}

/**
 * Create a progress bar visualization
 * @param {number} current - Current value
 * @param {number} total - Total value
 * @param {number} size - Size of progress bar (default: 10)
 * @param {string} filledChar - Character for filled portion (default: '█')
 * @param {string} emptyChar - Character for empty portion (default: '░')
 * @returns {string} Progress bar string
 */
function createProgressBar(current, total, size = 10, filledChar = '█', emptyChar = '░') {
  const percentage = Math.min(Math.max(current / total, 0), 1);
  const filledCount = Math.round(size * percentage);
  const emptyCount = size - filledCount;

  return filledChar.repeat(filledCount) + emptyChar.repeat(emptyCount);
}

// Simple credits system stored in credits.json
function addCreds(userId, amount) {
  const creditsFile = path.join(__dirname, 'credits.json');
  const data = readJsonFile(creditsFile, {});
  data[userId] = (data[userId] || 0) + amount;
  writeJsonFile(creditsFile, data);
  logToFile(`[Creds] Added ${amount} to ${userId}. Total: ${data[userId]}`);
}

module.exports = {
  getTimeUntilNextExecution,
  formatDuration,
  logToFile,
  createEmbed,
  readJsonFile,
  writeJsonFile,
  createProgressBar,
  addCreds
};
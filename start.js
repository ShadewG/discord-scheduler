// Simple startup script for Discord Scheduler Bot
console.log('Starting Discord Scheduler Bot...');

// Ensure logs directory exists
const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  console.log('Creating logs directory...');
  fs.mkdirSync(logsDir, { recursive: true });
}

// Load environment file
const dotenv = require('dotenv');
const result = dotenv.config({ path: path.resolve(__dirname, '.env') });

// Display current environment settings
console.log('\nEnvironment configuration:');
console.log(`- Working directory: ${__dirname}`);
console.log(`- .env file ${result.error ? 'not loaded (using system env)' : 'loaded successfully'}`);
console.log(`- DISCORD_TOKEN: ${process.env.DISCORD_TOKEN ? 'Set ✓' : 'Not set ✗'}`);
console.log(`- CHANNEL_ID: ${process.env.CHANNEL_ID || 'Not set ✗'}`);
console.log(`- ROLE_ID: ${process.env.ROLE_ID || 'Not set ✗'}`);
console.log(`- TZ: ${process.env.TZ || 'Not set (using Europe/Berlin)'}`);
console.log('\nStarting bot (press Ctrl+C to stop)...\n');

// Start the bot
require('./index.js'); 
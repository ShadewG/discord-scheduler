// Direct command registration for Insanity bot
// This script must be run with NODE_ENV=production

require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Configuration
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = '1275557298307203123'; // Specific guild ID
const NOTION_DB_ID = process.env.NOTION_DB_ID || '1e787c20070a80319db0f8a08f255c3c'; // For reference

// Setup logging
const logFile = path.join(__dirname, 'command-registration.log');
function log(message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}\n`;
  console.log(message);
  fs.appendFileSync(logFile, entry);
}

// Create a minimal Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

// Define the command
const command = {
  name: 'extract-tasks',
  description: 'Extract tasks from morning messages and create Notion pages'
};

// Register when the client is ready
client.once('ready', async () => {
  log('Bot is ready and registering command...');
  
  try {
    // Find the guild
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
      log(`❌ Guild with ID ${GUILD_ID} not found!`);
      
      // List available guilds
      log('Available guilds:');
      client.guilds.cache.forEach(g => {
        log(`- ${g.id}: ${g.name}`);
      });
      
      process.exit(1);
    }
    
    log(`Found guild: ${guild.name} (${guild.id})`);
    
    // Register the command
    try {
      const cmd = await guild.commands.create(command);
      log(`✅ Successfully registered command: ${cmd.name} (${cmd.id})`);
      
      // Display instructions
      log('\n-------------------------------------------');
      log('COMMAND REGISTERED SUCCESSFULLY!');
      log(`The /extract-tasks command is now available in the server: ${guild.name}`);
      log('-------------------------------------------\n');
      
      // Exit after a delay to ensure all logging is completed
      setTimeout(() => {
        process.exit(0);
      }, 1000);
      
    } catch (cmdError) {
      log(`❌ Error creating command: ${cmdError.message}`);
      if (cmdError.code === 50001) {
        log('This error indicates the bot does not have the "applications.commands" scope.');
        log('Please ensure the bot was invited with the correct permissions.');
      }
      process.exit(1);
    }
  } catch (error) {
    log(`❌ Error: ${error.message}`);
    process.exit(1);
  }
});

// Handle errors
client.on('error', error => {
  log(`❌ Discord client error: ${error.message}`);
});

// Log in
log('Connecting to Discord...');
client.login(TOKEN).catch(error => {
  log(`❌ Login error: ${error.message}`);
  process.exit(1);
}); 
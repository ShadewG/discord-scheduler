// register-bodycam-specific.js
// This script registers utility and notion commands to the INSANITY BODYCAM server

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { registerCommandsToGuild } = require('./auto-register-commands');

// Environment variables
const TOKEN = process.env.DISCORD_TOKEN;
const BODYCAM_SERVER_ID = '1290489132522672182';

// Categories to include
const CATEGORIES_TO_INCLUDE = ['basic', 'notion', 'utility'];

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

// Function to log to console
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// When the client is ready, run the code
client.once('ready', async () => {
  log(`Logged in as ${client.user.tag}`);
  
  try {
    log(`Registering commands from categories [${CATEGORIES_TO_INCLUDE.join(', ')}] to INSANITY BODYCAM server (${BODYCAM_SERVER_ID})...`);
    
    // Register commands to the server
    const success = await registerCommandsToGuild(
      client, 
      TOKEN, 
      BODYCAM_SERVER_ID, 
      CATEGORIES_TO_INCLUDE
    );
    
    if (success) {
      log('✅ Commands registered successfully to INSANITY BODYCAM server');
    } else {
      log('❌ Failed to register commands');
    }
  } catch (error) {
    log(`❌ Error: ${error.message}`);
    console.error(error);
  } finally {
    // Close the client connection
    log('Logging out...');
    client.destroy();
    log('Done!');
  }
});

// Handle errors
client.on('error', (error) => {
  log(`❌ Client error: ${error.message}`);
  console.error(error);
});

// Log in to Discord
log('Logging in to Discord...');
client.login(TOKEN).catch(error => {
  log(`❌ Login error: ${error.message}`);
  console.error(error);
}); 
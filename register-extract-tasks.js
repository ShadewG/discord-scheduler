/**
 * Register Extract Tasks Command
 * 
 * This script registers the /extract-tasks command to all guilds the bot is in.
 * Run this script directly: node register-extract-tasks.js
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Routes, REST } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Load environment variables
const TOKEN = process.env.DISCORD_TOKEN;
const NOTION_DB_ID = '1e787c20070a80319db0f8a08f255c3c'; // Specific database ID for tasks

// Setup logging
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  fs.appendFileSync(path.join(logDir, 'extract-tasks-command.log'), logMessage);
}

// Define the command
const command = {
  name: 'extract-tasks',
  description: 'Extract tasks from morning messages and create Notion pages'
};

// Main function
async function registerCommand() {
  try {
    log('Starting command registration process...');
    
    if (!TOKEN) {
      log('❌ Error: DISCORD_TOKEN is not set in .env file');
      process.exit(1);
    }
    
    // Method 1: Using REST API directly (doesn't require the bot to be online)
    log('Using REST API to register the command...');
    
    // Initialize REST API
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    
    try {
      // Get application/client ID
      log('Fetching application info...');
      const appInfo = await rest.get(Routes.oauth2CurrentApplication());
      const applicationId = appInfo.id;
      log(`Application ID: ${applicationId}`);
      
      // Get all guilds
      log('Fetching guilds...');
      const guildsResponse = await rest.get(Routes.userGuilds());
      
      if (!guildsResponse || !Array.isArray(guildsResponse) || guildsResponse.length === 0) {
        log('❌ No guilds found or invalid response');
        log(`Response: ${JSON.stringify(guildsResponse)}`);
        process.exit(1);
      }
      
      log(`Found ${guildsResponse.length} guilds`);
      
      // Register to each guild
      for (const guild of guildsResponse) {
        try {
          log(`Registering command to guild: ${guild.name} (${guild.id})`);
          
          await rest.post(Routes.applicationGuildCommands(applicationId, guild.id), {
            body: [command]
          });
          
          log(`✅ Successfully registered command to ${guild.name}`);
        } catch (guildError) {
          log(`❌ Error registering to guild ${guild.name}: ${guildError.message}`);
        }
      }
      
      log('Command registration process completed');
      
    } catch (restError) {
      log(`❌ REST API error: ${restError.message}`);
      log('Falling back to client method...');
      
      // Method 2: Using bot client (requires connecting)
      const client = new Client({ 
        intents: [GatewayIntentBits.Guilds]
      });
      
      client.once('ready', async () => {
        log(`Bot is ready as ${client.user.tag}`);
        
        try {
          log(`Bot is in ${client.guilds.cache.size} guilds`);
          
          // Register to each guild
          const results = [];
          for (const [id, guild] of client.guilds.cache) {
            try {
              log(`Registering command to guild: ${guild.name} (${id})`);
              
              const cmd = await guild.commands.create(command);
              
              log(`✅ Successfully registered command to ${guild.name}`);
              results.push({ guild: guild.name, id, success: true });
            } catch (guildError) {
              log(`❌ Error registering to guild ${guild.name}: ${guildError.message}`);
              results.push({ guild: guild.name, id, success: false, error: guildError.message });
            }
          }
          
          log('Command registration process completed');
          log(`Results: ${results.length} guilds processed`);
          log(`Success: ${results.filter(r => r.success).length}`);
          log(`Failed: ${results.filter(r => !r.success).length}`);
          
          // Exit after a small delay to ensure logs are written
          setTimeout(() => process.exit(0), 1000);
        } catch (error) {
          log(`❌ Error in ready handler: ${error.message}`);
          process.exit(1);
        }
      });
      
      client.on('error', (error) => {
        log(`❌ Client error: ${error.message}`);
      });
      
      log('Logging in to Discord...');
      await client.login(TOKEN);
    }
  } catch (error) {
    log(`❌ Unexpected error: ${error.message}`);
    process.exit(1);
  }
}

// Run the registration
registerCommand().catch(error => {
  log(`❌ Fatal error: ${error.message}`);
  process.exit(1);
}); 
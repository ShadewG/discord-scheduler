// register-commands.js - Script to register commands manually
// This script can be run manually to register commands

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { getAllCommands, getCommandsByCategory, commandsToJSON } = require('./commands');

// Get environment variables
const { DISCORD_TOKEN, CLIENT_ID } = process.env;

// Check if token and client ID are provided
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Error: Missing required environment variables (DISCORD_TOKEN, CLIENT_ID)');
  console.log('Please check your .env file or environment variables');
  process.exit(1);
}

// Create REST instance
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// Register commands globally (takes up to 1 hour to update)
async function registerGlobalCommands() {
  try {
    console.log('Started refreshing application (/) commands...');
    
    // Get all commands and convert to JSON
    const commandsData = commandsToJSON(getAllCommands());
    
    // Register commands globally
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commandsData },
    );
    
    console.log('✅ Successfully registered application commands globally!');
    console.log('Note: Global commands can take up to 1 hour to update in Discord');
  } catch (error) {
    console.error('Error registering commands:', error);
    if (error.rawError) {
      console.error('API Error details:', JSON.stringify(error.rawError, null, 2));
    }
  }
}

// Register commands to a specific guild (updates immediately)
async function registerGuildCommands(guildId) {
  try {
    console.log(`Started registering commands to guild ID: ${guildId}`);
    
    // Get all commands and convert to JSON
    const commandsData = commandsToJSON(getAllCommands());
    
    // Register commands to the guild
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, guildId),
      { body: commandsData },
    );
    
    console.log(`✅ Successfully registered commands to guild ID: ${guildId}`);
    console.log('Guild commands update immediately in Discord');
  } catch (error) {
    console.error(`Error registering commands to guild ${guildId}:`, error);
    if (error.rawError) {
      console.error('API Error details:', JSON.stringify(error.rawError, null, 2));
    }
  }
}

// Run the registration
(async () => {
  // To register to a specific guild, uncomment and add your guild ID:
  // You can get your guild ID by right-clicking on your server name and selecting "Copy ID"
  // This requires Developer Mode to be enabled in Discord (Settings > Advanced)
  const GUILD_ID = '1097551512912187432'; // Replace with your guild ID
  
  if (GUILD_ID) {
    await registerGuildCommands(GUILD_ID);
  } else {
    await registerGlobalCommands();
  }
})();

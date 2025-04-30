// auto-register-commands.js - Module to automatically register commands on startup
// This module handles command registration when the bot starts on Railway

const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getAllCommands, commandsToJSON, getCommandsByCategory } = require('./commands');

// Function to log to file
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Append to log file
  fs.appendFileSync(path.join(__dirname, 'command-registration.log'), logMessage);
  
  // Also log to console
  console.log(message);
}

// Function to register commands to specific guilds
async function registerToGuild(rest, clientId, guild) {
  try {
    logToFile(`Registering commands to guild: ${guild.name} (${guild.id})`);
    
    // Get all commands and convert to JSON format that Discord API expects
    const commandsData = commandsToJSON(getAllCommands());
    
    // Register commands to the guild
    await rest.put(
      Routes.applicationGuildCommands(clientId, guild.id),
      { body: commandsData },
    );
    
    logToFile(`✅ Successfully registered commands to guild: ${guild.name} (${guild.id})`);
    return true;
  } catch (error) {
    logToFile(`❌ Error registering commands to guild ${guild.name}: ${error.message}`);
    if (error.rawError) {
      logToFile(`API Error details: ${JSON.stringify(error.rawError, null, 2)}`);
    }
    return false;
  }
}

// Function to register specific command categories to a specific guild
async function registerCommandsToGuild(client, token, guildId, categoriesToInclude) {
  try {
    logToFile(`🔄 Registering specific command categories to guild ID: ${guildId}...`);
    
    // Initialize REST API client
    const rest = new REST({ version: '10' }).setToken(token);
    const clientId = client.user.id;
    
    // Find the guild
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      logToFile(`❌ Guild with ID ${guildId} not found`);
      return false;
    }
    
    // Get commands from specified categories
    let commandsToRegister = [];
    for (const category of categoriesToInclude) {
      const categoryCommands = getCommandsByCategory(category);
      logToFile(`Found ${categoryCommands.length} commands in category "${category}"`);
      commandsToRegister = [...commandsToRegister, ...categoryCommands];
    }
    
    // Convert to JSON format
    const commandsData = commandsToJSON(commandsToRegister);
    
    logToFile(`Registering ${commandsToRegister.length} commands to guild ${guild.name} (${guild.id})`);
    commandsToRegister.forEach(cmd => {
      logToFile(`- ${cmd.name}`);
    });
    
    // Register commands to the guild
    await rest.put(
      Routes.applicationGuildCommands(clientId, guild.id),
      { body: commandsData },
    );
    
    logToFile(`✅ Successfully registered ${commandsToRegister.length} commands to guild: ${guild.name} (${guild.id})`);
    return true;
  } catch (error) {
    logToFile(`❌ Error registering commands to guild ${guildId}: ${error.message}`);
    if (error.rawError) {
      logToFile(`API Error details: ${JSON.stringify(error.rawError, null, 2)}`);
    }
    return false;
  }
}

// Main function to register commands on startup
async function registerCommandsOnStartup(client, token) {
  try {
    logToFile('🔄 Automatically registering commands on startup...');
    
    // Initialize REST API client
    const rest = new REST({ version: '10' }).setToken(token);
    const clientId = client.user.id;
    
    // Register commands to all guilds the bot is in
    let successCount = 0;
    const guilds = client.guilds.cache;
    
    logToFile(`Bot is in ${guilds.size} guilds`);
    
    // Register to each guild
    for (const guild of guilds.values()) {
      const success = await registerToGuild(rest, clientId, guild);
      if (success) successCount++;
    }
    
    logToFile(`✅ Successfully registered commands to ${successCount} out of ${guilds.size} guilds`);
    
    return true;
  } catch (error) {
    logToFile(`❌ Error in auto-registration: ${error.message}`);
    logToFile(error.stack);
    return false;
  }
}

module.exports = {
  registerCommandsOnStartup,
  registerCommandsToGuild
};

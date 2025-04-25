// File to manually register critical commands
const { SlashCommandBuilder, REST, Routes } = require('discord.js');
const { DISCORD_TOKEN } = process.env;
const fs = require('fs');
const path = require('path');

// Setup logging
const logsDir = path.join(__dirname, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, 'command-fix.log');

// Helper function to write to log file
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Log to console
  console.log(message);
  
  // Append to log file
  fs.appendFileSync(logFile, logMessage);
}

// Register just the critical commands
async function registerCriticalCommands() {
  try {
    // Check if token is available
    if (!DISCORD_TOKEN) {
      logToFile('❌ Missing DISCORD_TOKEN environment variable');
      return;
    }
    
    logToFile('🔧 Manually registering critical commands...');
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    
    // Define just the critical commands that aren't showing up
    const criticalCommands = [
      new SlashCommandBuilder()
        .setName('link')
        .setDescription('Get the Notion link for the current project')
        .addBooleanOption(option =>
          option.setName('ephemeral')
            .setDescription('Make the response only visible to you')
            .setRequired(false)),
      
      new SlashCommandBuilder()
        .setName('where')
        .setDescription('Find all info about a project by code or link')
        .addStringOption(option => 
          option.setName('query')
            .setDescription('Project code (CL27) or any link (Frame.io, Script, YouTube)')
            .setRequired(true))
        .addBooleanOption(option =>
          option.setName('ephemeral')
            .setDescription('Make the response only visible to you')
            .setRequired(false)),
      
      new SlashCommandBuilder()
        .setName('availability')
        .setDescription('Show who is currently working and how much time they have left')
        .addBooleanOption(option =>
          option.setName('ephemeral')
            .setDescription('Make the response only visible to you')
            .setRequired(false)),
    ];
    
    const commandsData = criticalCommands.map(command => command.toJSON());
    
    // Get application ID from environment or fallback
    const clientId = process.env.CLIENT_ID;
    
    if (!clientId) {
      logToFile('❌ Missing CLIENT_ID environment variable');
      return;
    }
    
    logToFile(`Using application ID: ${clientId}`);
    
    // Register to specific guild if provided
    const guildId = process.env.GUILD_ID;
    
    if (guildId) {
      logToFile(`Registering commands for guild ID: ${guildId}`);
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commandsData }
      );
      logToFile('✅ Critical commands registered for specified guild');
    } else {
      // Register globally if no guild specified
      logToFile('Registering commands globally (will take up to 1 hour to appear)');
      await rest.put(Routes.applicationCommands(clientId), { body: commandsData });
      logToFile('✅ Critical commands registered globally');
    }
    
  } catch (error) {
    logToFile(`❌ Error in force-register: ${error.message}`);
    logToFile(error.stack);
  }
}

// Run the registration
registerCriticalCommands()
  .then(() => {
    logToFile('Command registration process completed');
  })
  .catch(err => {
    logToFile(`Top-level error: ${err.message}`);
    logToFile(err.stack);
  }); 
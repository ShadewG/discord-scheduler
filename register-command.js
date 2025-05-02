// Script to register the /extract-tasks command directly to a specific guild
require('dotenv').config();
const { REST } = require('discord.js');
const { Routes } = require('discord-api-types/v9');
const fs = require('fs');
const path = require('path');

// Load environment variables
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = '1275557298307203123'; // Explicitly set the guild ID
const CLIENT_ID = process.env.CLIENT_ID; // Get the client ID from environment

// Utility function for logging
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Ensure logs directory exists
  const logsDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
  }
  
  fs.appendFileSync(path.join(__dirname, 'logs', 'command-registration.log'), logMessage);
}

// Define the extract-tasks command
const commands = [
  {
    name: 'extract-tasks',
    description: 'Extract tasks from morning messages and create Notion pages'
  }
];

// Function to register the command
async function registerCommand() {
  try {
    console.log('Starting command registration process...');
    logToFile('Starting command registration process...');
    
    if (!TOKEN) {
      console.error('❌ Discord token is required but not provided');
      logToFile('❌ Discord token is required but not provided');
      process.exit(1);
    }
    
    if (!CLIENT_ID) {
      console.error('❌ CLIENT_ID is required but not provided in .env file');
      logToFile('❌ CLIENT_ID is required but not provided in .env file');
      process.exit(1);
    }
    
    console.log(`Registering command to guild: ${GUILD_ID}`);
    logToFile(`Registering command to guild: ${GUILD_ID}`);
    
    // Create REST instance
    const rest = new REST({ version: '9' }).setToken(TOKEN);
    
    try {
      // Register commands to the guild using the provided client ID
      console.log(`Using client ID: ${CLIENT_ID}`);
      console.log(`Registering guild command to guild ID: ${GUILD_ID}`);
      logToFile(`Using client ID: ${CLIENT_ID}`);
      logToFile(`Registering guild command to guild ID: ${GUILD_ID}`);
      
      await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commands }
      );
      
      console.log('✅ Guild command registered successfully!');
      logToFile('✅ Guild command registered successfully!');
    } catch (error) {
      console.error('Error registering command:', error);
      logToFile(`Error registering command: ${error.message}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    logToFile(`Unexpected error: ${error.message}`);
    process.exit(1);
  }
}

// Execute the registration
registerCommand()
  .then(() => {
    console.log('Command registration process completed');
    logToFile('Command registration process completed');
  })
  .catch(error => {
    console.error('Failed to register command:', error);
    logToFile(`Failed to register command: ${error.message}`);
    process.exit(1);
  }); 
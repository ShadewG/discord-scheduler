// register-test-command.js - A script to register just the test-link command
// This script focuses on registering a single command to verify the registration process

// Load environment variables
const path = require('path');
const { SlashCommandBuilder, REST, Routes } = require('discord.js');
const dotenv = require('dotenv');
const fs = require('fs');

// Try to load from .env file
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Get environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Validate environment variables
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment variables');
  process.exit(1);
}

// Define just the test command
const testCommand = new SlashCommandBuilder()
  .setName('test-link')
  .setDescription('Test command to verify registration is working')
  .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you'));

// Initialize REST API client
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// Function to log to file
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Append to log file
  fs.appendFileSync(path.join(__dirname, 'command-registration.log'), logMessage);
  
  // Also log to console
  console.log(message);
}

// Main function to register the test command
async function registerTestCommand() {
  try {
    console.log('Starting test command registration...');
    
    const commandData = testCommand.toJSON();
    console.log(`Registering test command: ${commandData.name}`);
    
    // Register globally first
    console.log('Registering command globally...');
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: [commandData] },
    );
    console.log('Successfully registered test command globally.');
    
    // Ask for guild ID input
    console.log('\n=== Guild-specific registration ===');
    console.log('To register the command to a specific guild for immediate testing:');
    console.log('1. Enable Developer Mode in Discord (Settings > Advanced > Developer Mode)');
    console.log('2. Right-click on your server icon and select "Copy ID"');
    console.log('3. Enter the guild ID below:');
    
    // Read guild ID from command line
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    readline.question('Enter your Discord server ID (or press Enter to skip): ', async (guildId) => {
      if (guildId && guildId.trim()) {
        // Register to specific guild
        console.log(`Registering command to guild: ${guildId}`);
        try {
          await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, guildId),
            { body: [commandData] },
          );
          console.log(`Successfully registered test command to guild: ${guildId}`);
          console.log('The command should be available immediately in this server.');
        } catch (guildError) {
          console.error(`Error registering to guild: ${guildError.message}`);
        }
      } else {
        console.log('Skipping guild-specific registration.');
      }
      
      console.log('\n=== Command Registration Complete ===');
      console.log('The test-link command has been registered.');
      console.log('Global commands may take up to an hour to propagate.');
      console.log('Guild-specific commands should be available immediately.');
      
      readline.close();
    });
    
  } catch (error) {
    console.error('Error registering test command:', error);
    console.error('Error details:', error.message);
    if (error.rawError) {
      console.error('API Error details:', JSON.stringify(error.rawError, null, 2));
    }
  }
}

// Run the registration function
registerTestCommand().catch(error => {
  console.error('Uncaught error:', error);
  process.exit(1);
});

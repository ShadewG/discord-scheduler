// fix-commands.js - A script to force re-register Discord commands
// This script will register commands both globally and to the first 5 guilds the bot is in

// Load environment variables
const path = require('path');
const { SlashCommandBuilder, REST, Routes, Client, GatewayIntentBits } = require('discord.js');
const dotenv = require('dotenv');
const fs = require('fs');

// Try to load from .env file
dotenv.config({ path: path.resolve(__dirname, '.env') });

const { DISCORD_TOKEN } = process.env;
const clientId = process.env.CLIENT_ID || ''; // Add your client ID to .env or provide it here

if (!DISCORD_TOKEN || !clientId) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment variables');
  process.exit(1);
}

// Define commands to register - make sure this matches what's in your main bot
const commands = [
  new SlashCommandBuilder().setName('link').setDescription('Get the Notion link for the current project')
    .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
  new SlashCommandBuilder().setName('availability').setDescription('Show a live time board of who is currently working')
    .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
  new SlashCommandBuilder().setName('sync').setDescription('Update Notion with properties from your message')
    .addStringOption(option => option.setName('text').setDescription('The properties to update').setRequired(true))
    .addBooleanOption(option => option.setName('dry_run').setDescription('Preview changes without updating Notion')),
  new SlashCommandBuilder().setName('analyze').setDescription('Analyze channel messages and update Notion')
    .addIntegerOption(option => option.setName('messages').setDescription('Number of messages to analyze (default: 100)'))
    .addBooleanOption(option => option.setName('dry_run').setDescription('Preview changes without updating Notion'))
    .addBooleanOption(option => option.setName('ephemeral').setDescription('Make response only visible to you')),
  new SlashCommandBuilder().setName('set').setDescription('Set a property on the Notion page for this channel')
    .addSubcommand(subcommand => subcommand.setName('status').setDescription('Set the Status property')
      .addStringOption(option => option.setName('value').setDescription('Status value').setRequired(true)
        .addChoices({ name: 'Writing', value: 'Writing' }, { name: 'Writing Review', value: 'Writing Review' },
                    { name: 'VA Render', value: 'VA Render' }, { name: 'Ready for Editing', value: 'Ready for Editing' },
                    { name: 'Clip Selection', value: 'Clip Selection' }, { name: 'MGX', value: 'MGX' },
                    { name: 'Pause', value: 'Pause' }))),
  // Add other commands here if needed
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// Create a client instance to get guild information
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// Function to log to file
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Append to log file
  fs.appendFileSync(path.join(__dirname, 'command-registration.log'), logMessage);
  
  // Also log to console
  console.log(message);
}

// Register commands globally
async function registerGlobalCommands() {
  try {
    logToFile('Started refreshing global application (/) commands.');
    
    const commandsData = commands.map(command => command.toJSON());
    logToFile(`Registering ${commandsData.length} commands globally for application ID: ${clientId}`);
    logToFile(`Command names being registered: ${commandsData.map(cmd => cmd.name).join(', ')}`);
    
    const response = await rest.put(
      Routes.applicationCommands(clientId),
      { body: commandsData },
    );
    
    logToFile(`Successfully registered ${response.length} global application commands.`);
    logToFile('Global commands will take up to an hour to propagate to all Discord servers.');
    
    return true;
  } catch (error) {
    logToFile(`Error registering global commands: ${error.message}`);
    if (error.rawError) {
      logToFile(`API Error details: ${JSON.stringify(error.rawError, null, 2)}`);
    }
    return false;
  }
}

// Register commands to a specific guild
async function registerGuildCommands(guildId, guildName) {
  try {
    logToFile(`Registering commands for guild: ${guildName} (${guildId})`);
    
    const commandsData = commands.map(command => command.toJSON());
    
    const response = await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commandsData },
    );
    
    logToFile(`Successfully registered ${response.length} commands for guild: ${guildName}`);
    logToFile('Guild commands should be available immediately.');
    
    return true;
  } catch (error) {
    logToFile(`Error registering commands for guild ${guildName}: ${error.message}`);
    if (error.rawError) {
      logToFile(`API Error details: ${JSON.stringify(error.rawError, null, 2)}`);
    }
    return false;
  }
}

// Delete all global commands (useful if you need to reset)
async function deleteAllGlobalCommands() {
  try {
    logToFile('Deleting all global application commands...');
    
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: [] },
    );
    
    logToFile('Successfully deleted all global application commands.');
    return true;
  } catch (error) {
    logToFile(`Error deleting global commands: ${error.message}`);
    return false;
  }
}

// Main function
async function main() {
  logToFile('=== Command Registration Utility ===');
  
  // First register commands globally
  const globalSuccess = await registerGlobalCommands();
  
  // Now login to get guild information
  logToFile('Logging in to Discord to get guild information...');
  
  try {
    await client.login(DISCORD_TOKEN);
    
    logToFile(`Logged in as ${client.user.tag}`);
    logToFile(`Bot is in ${client.guilds.cache.size} guilds`);
    
    // Register to the first 5 guilds for immediate testing
    let registerCount = 0;
    let successCount = 0;
    
    for (const guild of client.guilds.cache.values()) {
      if (registerCount < 5) { // Limit to 5 guilds to avoid rate limits
        const success = await registerGuildCommands(guild.id, guild.name);
        if (success) successCount++;
        registerCount++;
      }
    }
    
    logToFile(`Successfully registered commands to ${successCount} out of ${registerCount} guilds.`);
    
    // List all guilds the bot is in
    logToFile('\nBot is in the following guilds:');
    client.guilds.cache.forEach(guild => {
      logToFile(`- ${guild.name} (${guild.id})`);
    });
    
  } catch (error) {
    logToFile(`Error during Discord login: ${error.message}`);
  } finally {
    // Always destroy the client when done
    client.destroy();
  }
  
  logToFile('\n=== Command Registration Complete ===');
  logToFile('Check the Discord Developer Portal to verify commands are registered:');
  logToFile(`https://discord.com/developers/applications/${clientId}/information`);
  
  // Exit the process
  process.exit(0);
}

// Run the main function
main().catch(error => {
  logToFile(`Uncaught error: ${error.message}`);
  process.exit(1);
});

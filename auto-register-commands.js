// auto-register-commands.js - Module to automatically register commands on startup
// This module handles command registration when the bot starts on Railway

const { SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Function to log to file
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  // Append to log file
  fs.appendFileSync(path.join(__dirname, 'command-registration.log'), logMessage);
  
  // Also log to console
  console.log(message);
}

// Define all commands that should be registered
const commands = [
  // Basic bot commands
  new SlashCommandBuilder().setName('add').setDescription('Add a new scheduled reminder')
    .addStringOption(option => option.setName('time').setDescription('Time for the reminder (e.g., "every day at 9am")').setRequired(true))
    .addStringOption(option => option.setName('message').setDescription('Message to send').setRequired(true)),
  
  new SlashCommandBuilder().setName('list').setDescription('List all scheduled reminders'),
  
  new SlashCommandBuilder().setName('edit').setDescription('Edit a scheduled reminder')
    .addStringOption(option => option.setName('id').setDescription('ID of the reminder to edit').setRequired(true))
    .addStringOption(option => option.setName('time').setDescription('New time for the reminder'))
    .addStringOption(option => option.setName('message').setDescription('New message to send')),
  
  new SlashCommandBuilder().setName('status').setDescription('Check the bot status and configuration'),
  
  new SlashCommandBuilder().setName('help').setDescription('Show help information about the bot commands'),
  
  new SlashCommandBuilder().setName('test').setDescription('Send test messages for all scheduled reminders'),
  
  // Notion integration commands
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
  
  new SlashCommandBuilder().setName('notion').setDescription('Manage Notion status watchers')
    .addSubcommand(subcommand => subcommand.setName('add').setDescription('Add a new Notion watcher')
      .addStringOption(option => option.setName('property').setDescription('Property to watch').setRequired(true))
      .addStringOption(option => option.setName('value').setDescription('Value to watch for').setRequired(true))),
  
  new SlashCommandBuilder().setName('watch').setDescription('Create a Notion watcher to notify when properties change')
    .addStringOption(option => option.setName('property').setDescription('Property to watch').setRequired(true))
    .addStringOption(option => option.setName('value').setDescription('Value to watch for').setRequired(true)),
  
  new SlashCommandBuilder().setName('watchers').setDescription('List all Notion watchers in detail'),
  
  new SlashCommandBuilder().setName('where').setDescription('Find all projects matching a query')
    .addStringOption(option => option.setName('query').setDescription('Search query').setRequired(true))
    .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
  
  new SlashCommandBuilder().setName('schedule').setDescription('Show the weekly schedule of reminders'),
  
  new SlashCommandBuilder().setName('meeting').setDescription('Schedule a meeting with reminders')
    .addStringOption(option => option.setName('title').setDescription('Meeting title').setRequired(true))
    .addStringOption(option => option.setName('time').setDescription('Meeting time (e.g., "tomorrow at 3pm")').setRequired(true))
    .addStringOption(option => option.setName('description').setDescription('Meeting description'))
    .addBooleanOption(option => option.setName('remind').setDescription('Send reminder 5 minutes before')),
  
  // Test command
  new SlashCommandBuilder().setName('test-link').setDescription('Test command to verify registration is working')
    .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
];

// Function to register commands to specific guilds
async function registerToGuild(rest, clientId, guild) {
  try {
    logToFile(`Registering commands to guild: ${guild.name} (${guild.id})`);
    
    // Convert commands to JSON format that Discord API expects
    const commandsData = commands.map(command => command.toJSON());
    
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
  registerCommandsOnStartup
};

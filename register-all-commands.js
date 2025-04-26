// register-all-commands.js - A script to register ALL commands to a specific guild
// This script will register all commands to ensure they all show up in Discord

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

// Define ALL commands that should be registered
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

// Main function to register all commands
async function registerAllCommands() {
  try {
    console.log('Starting command registration...');
    
    const commandsData = commands.map(command => command.toJSON());
    console.log(`Registering ${commandsData.length} commands`);
    console.log(`Command names: ${commandsData.map(cmd => cmd.name).join(', ')}`);
    
    // Ask for guild ID input
    console.log('\n=== Guild-specific registration ===');
    console.log('To register commands to your server for immediate availability:');
    console.log('1. Enable Developer Mode in Discord (Settings > Advanced > Developer Mode)');
    console.log('2. Right-click on your server icon and select "Copy ID"');
    console.log('3. Enter the guild ID below:');
    
    // Read guild ID from command line
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    readline.question('Enter your Discord server ID: ', async (guildId) => {
      if (guildId && guildId.trim()) {
        // Register to specific guild
        console.log(`Registering commands to guild: ${guildId}`);
        try {
          const response = await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, guildId),
            { body: commandsData },
          );
          console.log(`Successfully registered ${response.length} commands to guild: ${guildId}`);
          console.log('The commands should be available immediately in this server.');
          
          // Also register globally for backup
          console.log('\nAlso registering commands globally for all servers...');
          await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commandsData },
          );
          console.log('Successfully registered commands globally (will take up to an hour to propagate).');
        } catch (guildError) {
          console.error(`Error registering to guild: ${guildError.message}`);
          if (guildError.rawError) {
            console.error('API Error details:', JSON.stringify(guildError.rawError, null, 2));
          }
        }
      } else {
        console.log('Guild ID is required. Please run the script again with a valid guild ID.');
        process.exit(1);
      }
      
      console.log('\n=== Command Registration Complete ===');
      console.log('All commands have been registered.');
      console.log('Guild commands should be available immediately.');
      console.log('Global commands may take up to an hour to propagate.');
      
      readline.close();
    });
    
  } catch (error) {
    console.error('Error registering commands:', error);
    console.error('Error details:', error.message);
    if (error.rawError) {
      console.error('API Error details:', JSON.stringify(error.rawError, null, 2));
    }
  }
}

// Run the registration function
registerAllCommands().catch(error => {
  console.error('Uncaught error:', error);
  process.exit(1);
});

// railway-fix-commands.js - A script to force re-register Discord commands on Railway
// This script is designed to be deployed to Railway to fix command registration issues

// Load environment variables
const path = require('path');
const { SlashCommandBuilder, REST, Routes } = require('discord.js');
const dotenv = require('dotenv');

// Try to load from .env file
dotenv.config({ path: path.resolve(__dirname, '.env') });

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

// Get environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Validate environment variables
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment variables');
  process.exit(1);
}

// Initialize REST API client
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// Main function to register commands
async function registerCommands() {
  try {
    console.log('Started refreshing application (/) commands.');
    console.log(`Using client ID: ${CLIENT_ID}`);
    
    const commandsData = commands.map(command => command.toJSON());
    console.log(`Registering ${commandsData.length} commands globally`);
    console.log(`Command names being registered: ${commandsData.map(cmd => cmd.name).join(', ')}`);
    
    // Register commands globally
    const globalResponse = await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commandsData },
    );
    
    console.log(`Successfully registered ${globalResponse.length} global commands.`);
    console.log('Global commands will take up to an hour to propagate to all Discord servers.');
    
    console.log('Command registration complete!');
    console.log('Check the Discord Developer Portal to verify commands are registered:');
    console.log(`https://discord.com/developers/applications/${CLIENT_ID}/information`);
    
  } catch (error) {
    console.error('Error registering commands:', error);
    console.error('Error details:', error.message);
    if (error.rawError) {
      console.error('API Error details:', JSON.stringify(error.rawError, null, 2));
    }
  }
}

// Run the registration function
registerCommands().then(() => {
  console.log('Command registration process completed.');
  // Exit after a delay to ensure logs are captured
  setTimeout(() => process.exit(0), 1000);
}).catch(error => {
  console.error('Uncaught error:', error);
  process.exit(1);
});

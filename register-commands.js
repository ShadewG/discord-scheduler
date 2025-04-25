// Force register Discord commands

// Load environment variables
const path = require('path');
const { SlashCommandBuilder, REST, Routes } = require('discord.js');
const dotenv = require('dotenv');

// Try to load from .env file
dotenv.config({ path: path.resolve(__dirname, '.env') });

const { DISCORD_TOKEN } = process.env;
const clientId = process.env.CLIENT_ID || ''; // Add your client ID to .env or provide it here

if (!DISCORD_TOKEN || !clientId) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment variables');
  process.exit(1);
}

// Define commands to register
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
  // Add other commands here...
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  try {
    console.log('Started refreshing application (/) commands.');

    const commandsData = commands.map(command => command.toJSON());
    
    // For global commands (works across all servers, but takes up to an hour to update)
    console.log(`Registering ${commandsData.length} commands globally for application ID: ${clientId}`);
    console.log(`Command names being registered: ${commandsData.map(cmd => cmd.name).join(', ')}`);
    
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commandsData },
    );

    console.log('Successfully registered application commands. They should show up in Discord within an hour.');
    console.log('If you want to update commands for a specific server immediately, use the guildId parameter.');
    
    // Optional: You can also register to a specific guild for immediate testing
    // Uncomment and replace YOUR_GUILD_ID with an actual guild ID where the bot is present
    /*
    const testGuildId = 'YOUR_GUILD_ID'; // Replace with your test server ID
    console.log(`Also registering commands to test guild: ${testGuildId} for immediate availability`);
    await rest.put(
      Routes.applicationGuildCommands(clientId, testGuildId),
      { body: commandsData },
    );
    console.log('Successfully registered application commands to test guild (immediate availability).');
    */
  } catch (error) {
    console.error('Error registering commands:', error);
    console.error('Error details:', error.message);
    if (error.rawError) {
      console.error('API Error details:', JSON.stringify(error.rawError, null, 2));
    }
  }
}

registerCommands();

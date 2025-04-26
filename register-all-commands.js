// register-all-commands.js - A script to register ALL commands to specific guilds
// This script will register commands to specific servers with selection options

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

// Define ALL commands that should be registered, grouped by category
const commandGroups = {
  // Basic bot commands
  basic: [
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
  ],
  
  // Notion integration commands
  notion: [
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
  ],
  
  // Meeting and schedule commands
  meetings: [
    new SlashCommandBuilder().setName('schedule').setDescription('Show the weekly schedule of reminders'),
    
    new SlashCommandBuilder().setName('meeting').setDescription('Schedule a meeting with reminders')
      .addStringOption(option => option.setName('title').setDescription('Meeting title').setRequired(true))
      .addStringOption(option => option.setName('time').setDescription('Meeting time (e.g., "tomorrow at 3pm")').setRequired(true))
      .addStringOption(option => option.setName('description').setDescription('Meeting description'))
      .addBooleanOption(option => option.setName('remind').setDescription('Send reminder 5 minutes before')),
  ],
  
  // Test commands
  test: [
    new SlashCommandBuilder().setName('test-link').setDescription('Test command to verify registration is working')
      .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
  ]
};

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

// Function to register commands to a specific guild
async function registerToGuild(guildId, commandsToRegister) {
  try {
    console.log(`Registering ${commandsToRegister.length} commands to guild: ${guildId}`);
    
    // Convert commands to JSON format that Discord API expects
    const commandsData = commandsToRegister.map(command => command.toJSON());
    
    // Register commands to the guild
    const response = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, guildId),
      { body: commandsData },
    );
    
    console.log(`✅ Successfully registered ${response.length} commands to guild: ${guildId}`);
    return true;
  } catch (error) {
    console.error(`❌ Error registering commands to guild ${guildId}: ${error.message}`);
    if (error.rawError) {
      console.error('API Error details:', JSON.stringify(error.rawError, null, 2));
    }
    return false;
  }
}

// Main function to register commands
async function registerCommands() {
  try {
    console.log('=== Discord Command Registration Utility ===');
    console.log('This utility will help you register commands to specific Discord servers.');
    
    // Get all available commands
    const allCommands = [
      ...commandGroups.basic,
      ...commandGroups.notion,
      ...commandGroups.meetings,
      ...commandGroups.test
    ];
    
    console.log(`\nAvailable command groups:`);
    console.log(`1. Basic commands (${commandGroups.basic.length}): ${commandGroups.basic.map(cmd => cmd.name).join(', ')}`);
    console.log(`2. Notion commands (${commandGroups.notion.length}): ${commandGroups.notion.map(cmd => cmd.name).join(', ')}`);
    console.log(`3. Meeting commands (${commandGroups.meetings.length}): ${commandGroups.meetings.map(cmd => cmd.name).join(', ')}`);
    console.log(`4. Test commands (${commandGroups.test.length}): ${commandGroups.test.map(cmd => cmd.name).join(', ')}`);
    console.log(`5. All commands (${allCommands.length})`);
    
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    // Function to prompt for guild ID
    const promptForGuildId = () => {
      return new Promise((resolve) => {
        console.log('\n=== Guild Registration ===');
        console.log('To register commands to your server:');
        console.log('1. Enable Developer Mode in Discord (Settings > Advanced > Developer Mode)');
        console.log('2. Right-click on your server icon and select "Copy ID"');
        
        readline.question('Enter your Discord server ID: ', (guildId) => {
          if (guildId && guildId.trim()) {
            resolve(guildId.trim());
          } else {
            console.log('Guild ID is required.');
            resolve(promptForGuildId());
          }
        });
      });
    };
    
    // Function to prompt for command group selection
    const promptForCommandGroup = () => {
      return new Promise((resolve) => {
        readline.question('\nWhich command group do you want to register? (1-5): ', (choice) => {
          const choiceNum = parseInt(choice.trim());
          if (isNaN(choiceNum) || choiceNum < 1 || choiceNum > 5) {
            console.log('Invalid choice. Please enter a number between 1 and 5.');
            resolve(promptForCommandGroup());
          } else {
            let selectedCommands;
            switch (choiceNum) {
              case 1: selectedCommands = commandGroups.basic; break;
              case 2: selectedCommands = commandGroups.notion; break;
              case 3: selectedCommands = commandGroups.meetings; break;
              case 4: selectedCommands = commandGroups.test; break;
              case 5: selectedCommands = allCommands; break;
            }
            resolve(selectedCommands);
          }
        });
      });
    };
    
    // Function to prompt for another registration
    const promptForAnother = () => {
      return new Promise((resolve) => {
        readline.question('\nDo you want to register more commands to another server? (y/n): ', (answer) => {
          resolve(answer.trim().toLowerCase() === 'y');
        });
      });
    };
    
    // Main registration loop
    let continueRegistration = true;
    while (continueRegistration) {
      const guildId = await promptForGuildId();
      const selectedCommands = await promptForCommandGroup();
      
      await registerToGuild(guildId, selectedCommands);
      
      continueRegistration = await promptForAnother();
    }
    
    console.log('\n=== Command Registration Complete ===');
    console.log('All requested commands have been registered.');
    console.log('Guild commands should be available immediately.');
    
    readline.close();
    
  } catch (error) {
    console.error('Error in registration process:', error);
    process.exit(1);
  }
}

// Run the registration function
registerCommands().catch(error => {
  console.error('Uncaught error:', error);
  process.exit(1);
});

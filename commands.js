// commands.js - Central module for all Discord slash commands
// This module serves as the single source of truth for all commands

const { SlashCommandBuilder } = require('discord.js');

// Define all commands grouped by category
const commands = {
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
    
    new SlashCommandBuilder().setName('deadline').setDescription('Show project deadlines from Notion')
      .addBooleanOption(option => option.setName('all').setDescription('Show all deadlines for this server\'s projects'))
      .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
    
    new SlashCommandBuilder().setName('set').setDescription('Set a property on the Notion page for this channel')
      .addSubcommand(subcommand => subcommand.setName('status').setDescription('Set the Status property')
        .addStringOption(option => option.setName('value').setDescription('Status value').setRequired(true)
          .addChoices(
            { name: 'Backlog', value: 'Backlog' },
            { name: 'FOIA Received', value: 'FOIA Received' },
            { name: 'Ready for production', value: 'Ready for production' },
            { name: 'Writing', value: 'Writing' }, 
            { name: 'Writing Review', value: 'Writing Review' },
            { name: 'VA Render', value: 'VA Render' },
            { name: 'VA Review', value: 'VA Review' },
            { name: 'Writing Revisions', value: 'Writing Revisions' },
            { name: 'Ready for Editing', value: 'Ready for Editing' },
            { name: 'Clip Selection', value: 'Clip Selection' },
            { name: 'Clip Selection Review', value: 'Clip Selection Review' },
            { name: 'MGX', value: 'MGX' },
            { name: 'MGX Review/Cleanup', value: 'MGX Review/Cleanup' },
            { name: 'Ready to upload', value: 'Ready to upload' },
            { name: 'Paused', value: 'Paused' },
            { name: 'TRIAL', value: 'TRIAL' }
          )))
      .addSubcommand(subcommand => subcommand.setName('caption_status').setDescription('Set the Caption Status property')
        .addStringOption(option => option.setName('value').setDescription('Caption status value').setRequired(true)
          .addChoices(
            { name: 'Ready For Captions', value: 'Ready For Captions' },
            { name: 'Captions In Progress', value: 'Captions In Progress' },
            { name: 'Captions Done', value: 'Captions Done' }
          )))
      .addSubcommand(subcommand => subcommand.setName('category').setDescription('Set the Category property')
        .addStringOption(option => option.setName('value').setDescription('Category value').setRequired(true)
          .addChoices(
            { name: 'CL', value: 'CL' },
            { name: 'Bodycam', value: 'Bodycam' },
            { name: 'IB', value: 'IB' }
          )))
      .addSubcommand(subcommand => subcommand.setName('date').setDescription('Set the Due Date property')
        .addStringOption(option => option.setName('value').setDescription('Date (e.g., "2023-05-15" or "May 15, 2023")').setRequired(true)))
      .addSubcommand(subcommand => subcommand.setName('storyboard').setDescription('Set the Storyboard property')
        .addStringOption(option => option.setName('value').setDescription('Storyboard URL (must start with http:// or https://)').setRequired(true)))
      .addSubcommand(subcommand => subcommand.setName('footage').setDescription('Set the Footage property')
        .addStringOption(option => option.setName('value').setDescription('Footage URL or status').setRequired(true)))
      .addSubcommand(subcommand => subcommand.setName('script').setDescription('Set the Script URL')
        .addStringOption(option => option.setName('value').setDescription('Script URL (must start with http:// or https://)').setRequired(true)))
      .addSubcommand(subcommand => subcommand.setName('frameio').setDescription('Set the Frame.io URL')
        .addStringOption(option => option.setName('value').setDescription('Frame.io URL (must start with http:// or https://)').setRequired(true)))
      .addSubcommand(subcommand => subcommand.setName('lead').setDescription('Set the Lead person')
        .addStringOption(option => option.setName('value').setDescription('Lead name').setRequired(true)))
      .addSubcommand(subcommand => subcommand.setName('editor').setDescription('Set the Editor person')
        .addStringOption(option => option.setName('value').setDescription('Editor name').setRequired(true)))
      .addSubcommand(subcommand => subcommand.setName('writer').setDescription('Set the Writer person')
        .addStringOption(option => option.setName('value').setDescription('Writer name').setRequired(true)))
      .addSubcommand(subcommand => subcommand.setName('3d_status').setDescription('Set the 3D Status property')
        .addStringOption(option => option.setName('value').setDescription('3D Status value').setRequired(true)))
      .addSubcommand(subcommand => subcommand.setName('language').setDescription('Set a language version status')
        .addStringOption(option => option.setName('language').setDescription('Language to update').setRequired(true)
          .addChoices(
            { name: 'Portuguese', value: 'Portuguese' },
            { name: 'Spanish', value: 'Spanish' },
            { name: 'Russian', value: 'Russian' },
            { name: 'Indonesian', value: 'Indonesian' }
          ))
        .addStringOption(option => option.setName('value').setDescription('Language status').setRequired(true)
          .addChoices(
            { name: 'Done', value: 'Done' },
            { name: 'Fixing Notes', value: 'Fixing Notes' },
            { name: 'In Progress', value: 'In Progress' },
            { name: 'QC', value: 'QC' },
            { name: 'Approved for dub', value: 'Approved for dub' },
            { name: 'Uploaded', value: 'Uploaded' }
          ))),
    
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
    
    new SlashCommandBuilder().setName('changelog').setDescription('Show status changelog for the current project')
      .addStringOption(option => option.setName('project').setDescription('Project code (defaults to current channel)'))
      .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
  ],
  
  // Meeting and schedule commands
  meetings: [
    new SlashCommandBuilder().setName('schedule').setDescription('Show the weekly schedule of reminders')
      .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
    
    new SlashCommandBuilder().setName('meeting').setDescription('Schedule a meeting with reminders')
      .addStringOption(option => option.setName('title').setDescription('Meeting title').setRequired(true))
      .addStringOption(option => option.setName('time').setDescription('Meeting time (e.g., "tomorrow at 3pm")').setRequired(true))
      .addStringOption(option => option.setName('description').setDescription('Meeting description'))
      .addStringOption(option => option.setName('users').setDescription('Users to invite (use @ mentions)'))
      .addBooleanOption(option => option.setName('remind').setDescription('Send reminder 5 minutes before')),
      
    new SlashCommandBuilder().setName('send').setDescription('Manually send a scheduled message')
      .addStringOption(option => 
        option.setName('message_type')
          .setDescription('The type of message to send')
          .setRequired(true)
          .addChoices(
            { name: 'Social Fika', value: 'Social Fika' },
            { name: 'Deep Work AM', value: 'Deep Work AM' },
            { name: 'Fika Break', value: 'Fika Break' },
            { name: 'Deep Work Continue', value: 'Deep Work Continue' },
            { name: 'Lunch Break', value: 'Lunch Break' },
            { name: 'Planning Huddle', value: 'Planning Huddle' },
            { name: 'Deep Work PM', value: 'Deep Work PM' },
            { name: 'Wrap-Up Meeting', value: 'Wrap-Up Meeting' }
          ))
      .addBooleanOption(option => option.setName('notification').setDescription('Send as a notification (5 min before) instead of the main message')),
      
    // Add the test_schedule command for debugging
    new SlashCommandBuilder().setName('test_schedule').setDescription('Test sending a scheduled message (admin only)')
      .addStringOption(option => 
        option.setName('message_type')
          .setDescription('The type of message to test')
          .setRequired(true)
          .addChoices(
            { name: 'Social Fika', value: 'Social Fika' },
            { name: 'Deep Work AM', value: 'Deep Work AM' },
            { name: 'Fika Break', value: 'Fika Break' },
            { name: 'Deep Work Continue', value: 'Deep Work Continue' },
            { name: 'Lunch Break', value: 'Lunch Break' },
            { name: 'Planning Huddle', value: 'Planning Huddle' },
            { name: 'Deep Work PM', value: 'Deep Work PM' },
            { name: 'Wrap-Up Meeting', value: 'Wrap-Up Meeting' }
          ))
      .addBooleanOption(option => option.setName('remove_tag').setDescription('Remove @Schedule tag from message')),
  ],
  
  // New utility commands
  utility: [
    new SlashCommandBuilder().setName('dashboard').setDescription('Show a project dashboard with key metrics and status')
      .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
    
    new SlashCommandBuilder().setName('timeline').setDescription('Generate a visual timeline of project milestones')
      .addStringOption(option => option.setName('timeframe').setDescription('Timeframe to display (e.g., "week", "month")')
        .addChoices({ name: 'Week', value: 'week' }, { name: 'Month', value: 'month' }, { name: 'Quarter', value: 'quarter' }))
      .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
    
    new SlashCommandBuilder().setName('export').setDescription('Export project data to a file')
      .addStringOption(option => option.setName('format').setDescription('Export format').setRequired(true)
        .addChoices({ name: 'CSV', value: 'csv' }, { name: 'JSON', value: 'json' }, { name: 'Text', value: 'txt' }))
      .addBooleanOption(option => option.setName('include_history').setDescription('Include historical data')),
    
    new SlashCommandBuilder().setName('summary').setDescription('Generate an AI summary of recent project activity')
      .addIntegerOption(option => option.setName('days').setDescription('Number of days to summarize (default: 7)'))
      .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
      
    new SlashCommandBuilder().setName('remind').setDescription('Set a reminder for a user')
      .addUserOption(option => option.setName('user').setDescription('User to remind').setRequired(true))
      .addStringOption(option => option.setName('message').setDescription('Reminder message').setRequired(true))
      .addStringOption(option => option.setName('time').setDescription('When to send the reminder (e.g., "30m", "1h", "tomorrow 2pm")').setRequired(true))
      .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the confirmation only visible to you')),
      
    // Add the ask command for the knowledge assistant
    new SlashCommandBuilder().setName('ask').setDescription('Ask a question about guides, workflows, or best practices')
      .addStringOption(option => option.setName('question').setDescription('What would you like to know?').setRequired(true))
      .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
      
    // Add extract-tasks command to ensure it's registered properly
    new SlashCommandBuilder().setName('extract-tasks').setDescription('Extract tasks from morning messages and create Notion pages'),
    
    // Add check-tasks command to manually run the end-of-day task check
    new SlashCommandBuilder().setName('check-tasks').setDescription('Check for completed tasks in recent messages'),

    // Add issue-report command to compile logs from Discord and Frame.io
    new SlashCommandBuilder().setName('issue-report').setDescription('Compile a report of recent messages')
      .addStringOption(option =>
        option.setName('timeframe').setDescription('Timeframe to analyze')
          .setRequired(true)
          .addChoices({ name: 'Week', value: 'week' }, { name: 'Month', value: 'month' }))
      .addBooleanOption(option => option.setName('ephemeral').setDescription('Make the response only visible to you')),
  ],
};

// Helper function to get all commands as a flat array
function getAllCommands() {
  return [
    ...commands.basic,
    ...commands.notion,
    ...commands.meetings,
    ...commands.utility
  ];
}

// Helper function to get commands by category
function getCommandsByCategory(category) {
  return commands[category] || [];
}

// Helper function to convert commands to JSON format for Discord API
function commandsToJSON(commandsList) {
  return commandsList.map(command => command.toJSON());
}

module.exports = {
  commands,
  getAllCommands,
  getCommandsByCategory,
  commandsToJSON
};

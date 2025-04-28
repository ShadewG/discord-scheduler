// Discord Bot for Insanity
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const { OpenAI } = require('openai');
const { Client: NotionClient } = require('@notionhq/client');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');

// Import availability module
const { STAFF_AVAILABILITY, isStaffActive, getTimeLeftInShift, createTimeProgressBar, formatWorkingHours } = require('./availability');

// Define timezone for all operations
const TZ = 'Europe/Berlin';

// Map of active jobs
const activeJobs = new Map();

// Schedule notification channel ID
const SCHEDULE_CHANNEL_ID = '1364301344508477541'; // Daily Work Schedule channel
const SCHEDULE_ROLE_ID = '1364657163598823474'; // Role ID to notify for scheduled meetings

// Team mention role ID
const TEAM_ROLE_ID = '1364657163598823474';

// Store jobs in memory, each with a tag, cron expression, text, and whether to send a notification 5 min before
let jobs = [
  { tag: 'Morning Stand-up', cron: '0 9 * * 1-5', text: `📋 <@&${TEAM_ROLE_ID}> **Morning Stand-up** (9:00-9:30) - Daily planning meeting to discuss goals and blockers.`, notify: true },
  { tag: 'Deep Work Session 1', cron: '30 9 * * 1-5', text: '🧠 **Deep Work Session 1** (9:30-12:00) - Focused work time with minimal interruptions.' },
  { tag: 'Lunch Break', cron: '0 12 * * 1-5', text: `🍽️ <@&${TEAM_ROLE_ID}> **Lunch Break** (12:00-13:00) - Time to recharge!`, notify: true },
  { tag: 'Team Sync Meeting', cron: '0 13 * * 1-5', text: `🔄 <@&${TEAM_ROLE_ID}> **Team Sync Meeting** (13:00-14:00) - Weekly progress update and roadmap discussion.`, notify: true },
  { tag: 'Deep Work Session 2', cron: '0 14 * * 1-5', text: '🧠 **Deep Work Session 2** (14:00-16:00) - Afternoon focus time for project execution.' },
  { tag: 'Client Call', cron: '0 16 * * 1,3,5', text: `📞 <@&${TEAM_ROLE_ID}> **Client Call** (16:00-17:00) - Scheduled client meeting on Monday, Wednesday, Friday.`, notify: true },
  { tag: 'Project Planning', cron: '0 16 * * 2,4', text: `📊 <@&${TEAM_ROLE_ID}> **Project Planning** (16:00-17:00) - Internal planning session on Tuesday and Thursday.`, notify: true },
  { tag: 'End of Day', cron: '0 17 * * 1-5', text: '👋 **End of Day** - That\'s a wrap! Remember to log your hours and update task status.' }
];

// Add 5-minute notification jobs for any events that need them
const notificationJobs = jobs
  .filter(job => job.notify)
  .map(job => {
    // Parse cron to get the time
    const cronParts = job.cron.split(' ');
    const hour = parseInt(cronParts[1]);
    const minute = parseInt(cronParts[0]);
    
    // Calculate notification time (5 minutes before)
    let notifyMinute = minute - 5;
    let notifyHour = hour;
    if (notifyMinute < 0) {
      notifyMinute += 60;
      notifyHour -= 1;
      if (notifyHour < 0) {
        notifyHour = 23;
      }
    }
    
    // Format as cron
    const notifyCron = `${notifyMinute} ${notifyHour} * * ${cronParts[4]}`;
    
    // Get the meeting name from the original text
    const meetingNameMatch = job.text.match(/\*\*(.*?)\*\*/);
    const meetingName = meetingNameMatch ? meetingNameMatch[1] : job.tag;
    
    return {
      tag: `${job.tag} Notification`,
      cron: notifyCron,
      text: `🔔 <@&${TEAM_ROLE_ID}> **${meetingName}** starting in 5 minutes!`,
      isNotification: true
    };
  });

// Combine regular jobs and notification jobs
jobs = [...jobs, ...notificationJobs];

// Helper function to get the next execution time for a cron expression
function getNextExecution(cronExpression) {
  try {
    // Get current time
    const now = new Date();
    
    // Schedule a one-time job to get the next date
    const scheduler = cron.schedule(cronExpression, () => {}, { 
      timezone: TZ,
      scheduled: false
    });
    
    // Get the next execution date
    const nextDate = scheduler.nextDate().toDate();
    
    // Stop the job
    scheduler.stop();
    
    // Calculate the time difference
    const diffMs = nextDate - now;
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
    
    // Format the next date in the specified timezone
    const formatted = nextDate.toLocaleString('en-US', { 
      timeZone: TZ,
      weekday: 'short',
      month: 'short', 
      day: 'numeric',
      hour: '2-digit', 
      minute: '2-digit'
    });
    
    // Format the time left
    const formattedTimeLeft = `${hours}h ${minutes}m`;
    
    return { 
      date: nextDate, 
      formatted, 
      timeLeft: { hours, minutes, seconds },
      formattedTimeLeft 
    };
  } catch (error) {
    console.error(`Error calculating next execution: ${error.message}`);
    return null;
  }
}

// Function to create schedule embed
function createScheduleEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x00AAFF)
    .setTitle('Daily Work Schedule')
    .setDescription(`Current time in ${TZ}: **${moment().tz(TZ).format('dddd, MMM D, HH:mm')}**`)
    .setTimestamp();

  // Process jobs for display
  const upcomingJobs = [];
  const regularJobs = [];
  
  // Only process non-notification jobs for display in the regular schedule
  const displayJobs = jobs.filter(job => !job.isNotification);
  
  displayJobs.forEach(job => {
    const nextExecution = getNextExecution(job.cron);
    if (!nextExecution) return;
    
    // Create formatted job info
    const jobInfo = {
      tag: job.tag,
      cronExpr: job.cron,
      text: job.text,
      next: nextExecution,
      timeUntil: nextExecution.formattedTimeLeft,
      formatted: nextExecution.formatted
    };
    
    // Add to upcoming if it's within the next 12 hours
    if (nextExecution.timeLeft.hours < 12) {
      upcomingJobs.push(jobInfo);
    } else {
      regularJobs.push(jobInfo);
    }
  });
  
  // Sort upcoming jobs by execution time
  upcomingJobs.sort((a, b) => a.next.date.getTime() - b.next.date.getTime());
  
  // Sort regular jobs by time of day
  const sortByTimeOfDay = (a, b) => {
    const getMinutes = (cronExpr) => {
      const parts = cronExpr.split(' ');
      return parseInt(parts[0]) + parseInt(parts[1]) * 60;
    };
    return getMinutes(a.cronExpr) - getMinutes(b.cronExpr);
  };
  
  regularJobs.sort(sortByTimeOfDay);
  
  // Add upcoming reminders section if there are any
  if (upcomingJobs.length > 0) {
    embed.addFields({ 
      name: '⏰ UPCOMING SCHEDULE EVENTS', 
      value: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    });
    
    upcomingJobs.forEach((job, index) => {
      // Extract time from cron
      const cronParts = job.cronExpr.split(' ');
      const hour = cronParts[1].padStart(2, '0');
      const minute = cronParts[0].padStart(2, '0');
      
      embed.addFields({ 
        name: `${index + 1}. ${job.tag} (${hour}:${minute})`, 
        value: `⏱️ In: **${job.timeUntil}**\n🕒 At: ${job.formatted}\n📝 ${job.text.replace('@Schedule', '').trim()}`
      });
    });
  }
  
  // Add full day schedule
  embed.addFields({ 
    name: '📅 DAILY SCHEDULE (Mon-Fri)', 
    value: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  });
  
  regularJobs.forEach((job) => {
    // Extract hour and minute from cron for readability
    const cronParts = job.cronExpr.split(' ');
    const hour = cronParts[1].padStart(2, '0');
    const minute = cronParts[0].padStart(2, '0');
    
    embed.addFields({ 
      name: `${hour}:${minute} — ${job.tag}`, 
      value: job.text.replace('@Schedule', '').trim()
    });
  });
  
  embed.setFooter({ text: 'All times are in Europe/Berlin timezone' });
  
  return embed;
}

// Load environment variables
const TOKEN = process.env.DISCORD_TOKEN;
const NOTION_KEY = process.env.NOTION_TOKEN || process.env.NOTION_KEY; // Support both naming conventions
const DB = process.env.NOTION_DB_ID || process.env.NOTION_DATABASE_ID; // Support both naming conventions
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GUILD_ID = process.env.GUILD_ID;

// Validate required environment variables
if (!TOKEN) {
  console.error('❌ ERROR: DISCORD_TOKEN is required but not provided in .env file');
  process.exit(1);
}

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// Function to send a message to the specified channel
function ping(message) {
  try {
    // Find the Schedule channel by ID
    const channel = client.channels.cache.get(SCHEDULE_CHANNEL_ID);
    
    if (channel) {
      // Send the message
      channel.send(message)
        .then(() => logToFile(`Sent schedule message to #${channel.name}: ${message}`))
        .catch(err => logToFile(`Error sending message: ${err.message}`));
    } else {
      logToFile(`Could not find schedule channel with ID ${SCHEDULE_CHANNEL_ID}`);
    }
  } catch (error) {
    logToFile(`Error in ping function: ${error.message}`);
  }
}

// Initialize Notion client
let notion = null;
try {
  if (NOTION_KEY && DB) {
    notion = new NotionClient({
      auth: NOTION_KEY
    });
    console.log('✅ Notion client initialized successfully');
  } else {
    console.warn('⚠️ NOTION_KEY or NOTION_DATABASE_ID not provided. Notion features will be disabled.');
  }
} catch (error) {
  console.warn('⚠️ Failed to initialize Notion client: ' + error.message + '. Notion features will be disabled.');
}

// Utility function for logging
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(path.join(__dirname, 'bot.log'), logMessage);
}

// Initialize OpenAI client if API key is provided
let openai = null;
try {
  if (OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    console.log('✅ OpenAI client initialized successfully');
  } else {
    console.warn('⚠️ OPENAI_API_KEY not provided. AI features will be disabled.');
  }
} catch (error) {
  console.warn('⚠️ Failed to initialize OpenAI: ' + error.message + '. AI features will be disabled.');
}

// Error handler
client.on('error', (error) => {
  console.error('Error:', error);
  logToFile(`Error: ${error.message}`);
});

// Get Notion page URL
function getNotionPageUrl(pageId) {
  if (!pageId) return null;
  // Format is: https://www.notion.so/{workspace}/{page-id}
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

// Function to find a project by query
async function findProjectByQuery(query) {
  if (!query) return null;
  
  // Check if Notion client is initialized
  if (!notion) {
    logToFile('❌ Cannot search for projects: Notion client is not initialized');
    throw new Error('Notion client is not initialized. Please check your environment variables.');
  }
  
  try {
    // Case 1: Direct ID lookup
    if (query.match(/^[a-zA-Z0-9-]+$/)) {
      try {
        const page = await notion.pages.retrieve({ page_id: query });
        return page;
      } catch (error) {
        // Not a valid ID, continue to search
        logToFile(`Not a valid page ID: ${query}. Continuing to search by name.`);
      }
    }
    
    // Case 2: Search by name or partial match
    const response = await notion.databases.query({
      database_id: DB,
      filter: {
        property: "Project name",
        title: {
          contains: query
        }
      }
    });
    
    if (response.results.length > 0) {
      // Return both the page and the code for reference
      const page = response.results[0];
      
      // Extract code from the beginning of the project name (usually something like IB23, CL45, etc.)
      const projectName = page.properties["Project name"]?.title?.[0]?.plain_text || '';
      const codeMatch = projectName.match(/^([A-Z]{2}\d{2})/);
      const code = codeMatch ? codeMatch[0] : query;
      
      return { page, code };
    }
    
    return null;
  } catch (error) {
    logToFile(`Error finding project: ${error.message}`);
    throw error;
  }
}

// When the client is ready, run this code
client.once('ready', () => {
  console.log('Bot is ready!');
  logToFile('Bot started successfully');
  
  // Register commands on startup
  try {
    const { registerCommandsOnStartup } = require('./auto-register-commands');
    registerCommandsOnStartup(client, TOKEN)
      .then(() => console.log('Commands registered successfully'))
      .catch(error => {
        console.error('Error registering commands:', error);
        logToFile(`Error registering commands: ${error.message}`);
      });
  } catch (error) {
    console.error('Error registering commands:', error);
    logToFile(`Error registering commands: ${error.message}`);
  }
  
  // Schedule all jobs
  scheduleAllJobs();
});

// Handle slash command interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;
  
  // Add global error handling for all command interactions
  try {
    // Create a timeout to track if we're at risk of hitting Discord's 3-second limit
    let hasResponded = false;
    
    // Handle the /where command
    if (commandName === 'where') {
      try {
        await interaction.deferReply();
        hasResponded = true;
        
        // Check if Notion is configured
        if (!notion) {
          await interaction.editReply('❌ Notion integration is not configured. Please ask an administrator to set up the Notion API token and database ID.');
          return;
        }
        
        const query = interaction.options.getString('query');
        if (!query) {
          await interaction.editReply('Please provide a project name or code.');
          return;
        }
        
        const result = await findProjectByQuery(query);
        if (!result) {
          await interaction.editReply(`❌ Could not find a project matching "${query}"`);
          return;
        }
        
        // Get the page details from the result
        const project = result.page;
        
        // Get project properties
        const properties = project.properties;
        const projectName = properties["Project name"]?.title?.[0]?.plain_text || 'Unnamed Project';
        // Get code from the result or extract from project name
        const code = result.code || projectName.match(/^([A-Z]{2}\d{2})/)?.['0'] || 'Unknown';
        
        // Status could be under different property names, try them all
        let status = 'No Status';
        if (properties.Status?.select?.name) {
          status = properties.Status.select.name;
        } else if (properties['Status']?.select?.name) {
          status = properties['Status'].select.name;
        } else if (properties.status?.select?.name) {
          status = properties.status.select.name;
        } else {
          // Log all property names for debugging
          logToFile(`Available properties for ${code}: ${Object.keys(properties).join(', ')}`);
        }
        
        const dueDate = properties.Date?.date?.start || 'No Due Date';
        const lead = properties.Lead?.people?.map(p => p.name).join(', ') || 'No Lead';
        const editors = properties.Editor?.multi_select?.map(e => e.name).join(', ') || 'None';
        
        // Check for script URL in multiple possible property names
        let scriptUrl = '';
        if (properties.Script?.url) {
          scriptUrl = properties.Script.url;
        } else if (properties['Script']?.url) {
          scriptUrl = properties['Script'].url;
        } else if (properties.script?.url) {
          scriptUrl = properties.script.url;
        }
        
        // Check for Frame.io URL
        let frameioUrl = '';
        if (properties["Frame.io"]?.url) {
          frameioUrl = properties["Frame.io"].url;
        } else if (properties['Frame.io']?.url) {
          frameioUrl = properties['Frame.io'].url;
        }
        
        // Get Notion URL
        const notionUrl = getNotionPageUrl(project.id);
        
        // Look for Discord channels with this code
        const codePattern = code.toLowerCase();
        const guild = interaction.guild;
        const discordChannels = guild.channels.cache
          .filter(channel => channel.type === 0 && channel.name.includes(codePattern))
          .map(channel => ({ id: channel.id, channel }));
        
        // Create embed
        const embed = new EmbedBuilder()
          .setTitle(`Project: ${code}`)
          .setColor(0x0099FF)
          .setDescription(`Here's everything you need for project **${code}**:`)
          .setTimestamp();
        
        // Add Notion Card
        if (notionUrl) {
          embed.addFields({ name: '📋 Notion Card', value: notionUrl });
        }
        
        // Add Discord Channels if found
        if (discordChannels.length > 0) {
          embed.addFields({ 
            name: '💬 Discord Channel', 
            value: discordChannels.map(ch => `<#${ch.id}>`).join('\n') 
          });
        }
        
        // Add Frame.io link
        if (frameioUrl) {
          embed.addFields({ name: '🎬 Frame.io', value: frameioUrl });
        }
        
        // Add Status
        embed.addFields({ name: '📊 Status', value: status || 'Not Set' });
        
        // Add Due Date if present
        if (dueDate && dueDate !== 'No Due Date') {
          const formattedDate = new Date(dueDate).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
          });
          embed.addFields({ name: '📅 Due Date', value: formattedDate, inline: true });
        }
        
        // If script URL not found in Notion, check Discord channel for Google Doc links
        let foundScriptInDiscord = false;
        if (!scriptUrl && discordChannels.length > 0) {
          try {
            // Look at the first matching Discord channel
            const channel = discordChannels[0].channel;
            logToFile(`Looking for Google Doc links in channel #${channel.name}`);
            
            // Fetch last 100 messages
            const messages = await channel.messages.fetch({ limit: 100 });
            
            // Log how many messages we found for debugging
            logToFile(`Found ${messages.size} messages in channel #${channel.name}`);
            
            // Find messages with Google Doc links
            const docMessages = messages.filter(msg => {
              const content = msg.content.toLowerCase();
              return content.includes('docs.google.com') || 
                     content.includes('drive.google.com/document');
            });
            
            // Log how many doc messages we found
            logToFile(`Found ${docMessages.size} messages with Google Doc links`);
            
            if (docMessages.size > 0) {
              // Sort by timestamp to get the most recent one
              const sortedMessages = [...docMessages.values()]
                .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
              
              // Get the most recent message with a Google Doc link
              const recentDocMessage = sortedMessages[0];
              
              // Extract the URL from the message
              const msgContent = recentDocMessage.content;
              logToFile(`Found message with content: ${msgContent}`);
              
              // More comprehensive regex to catch all sorts of Google links
              const urlMatch = msgContent.match(/(https?:\/\/docs\.google\.com\S+|https?:\/\/drive\.google\.com\S+)/i);
              
              if (urlMatch && urlMatch[0]) {
                scriptUrl = urlMatch[0];
                foundScriptInDiscord = true;
                logToFile(`Found script URL in Discord: ${scriptUrl}`);
              } else {
                logToFile(`Regex did not match any Google Doc links in: ${msgContent}`);
              }
            }
          } catch (discordError) {
            logToFile(`Error searching Discord for script links: ${discordError.message}`);
            // Continue with the rest of the function, don't throw
          }
        }
        
        // Add Script URL if present (from Notion or Discord)
        if (scriptUrl) {
          const fieldName = foundScriptInDiscord ? 
            '📝 Script (from Discord)' : 
            '📝 Script';
          embed.addFields({ name: fieldName, value: scriptUrl });
        }
        
        // Add People info
        if (lead !== 'No Lead') {
          embed.addFields({ name: '🎬 Lead', value: lead, inline: true });
        }
        
        if (editors !== 'None') {
          embed.addFields({ name: '✂️ Editors', value: editors, inline: true });
        }
        
        // Create buttons for links
        const buttons = [];
        
        if (notionUrl) {
          buttons.push(
            new ButtonBuilder()
              .setLabel('Open in Notion')
              .setStyle(ButtonStyle.Link)
              .setURL(notionUrl)
          );
        }
        
        if (frameioUrl) {
          buttons.push(
            new ButtonBuilder()
              .setLabel('Open Frame.io')
              .setStyle(ButtonStyle.Link)
              .setURL(frameioUrl)
          );
        }
        
        if (scriptUrl) {
          const buttonLabel = foundScriptInDiscord ? 'Open Script (Discord)' : 'Open Script';
          buttons.push(
            new ButtonBuilder()
              .setLabel(buttonLabel)
              .setStyle(ButtonStyle.Link)
              .setURL(scriptUrl)
          );
        }
        
        // Add buttons if we have any
        const components = [];
        if (buttons.length > 0) {
          const row = new ActionRowBuilder().addComponents(...buttons);
          components.push(row);
        }
        
        await interaction.editReply({ 
          embeds: [embed],
          components: components.length > 0 ? components : undefined
        });
      } catch (error) {
        logToFile(`Error in /where command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error finding project: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error finding project: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /availability command
    else if (commandName === 'availability') {
      try {
        // Check if ephemeral flag is set
        const ephemeral = interaction.options.getBoolean('ephemeral') !== false; // Default to true
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        
        // Current Berlin time
        const berlinTime = moment().tz('Europe/Berlin').format('dddd, MMMM D, YYYY HH:mm:ss');
        
        // Create the embed
        const embed = new EmbedBuilder()
          .setTitle('Team Availability')
          .setDescription(`Current time in Berlin: **${berlinTime}**\nStaff currently working are highlighted below:`)
          .setColor(0x00AAFF)
          .setTimestamp();
        
        // Group staff by availability status
        const activeStaff = [];
        const inactiveStaff = [];
        
        // Process each staff member
        STAFF_AVAILABILITY.forEach(staff => {
          const isActive = isStaffActive(staff);
          const timeLeft = getTimeLeftInShift(staff);
          const workingHours = formatWorkingHours(staff);
          
          const staffInfo = {
            name: staff.name,
            isActive,
            timeLeft,
            workingHours
          };
          
          if (isActive) {
            activeStaff.push(staffInfo);
          } else {
            inactiveStaff.push(staffInfo);
          }
        });
        
        // Add active staff field with inline status
        if (activeStaff.length > 0) {
          const activeStaffText = activeStaff.map(staff => 
            `**${staff.name}** (${staff.timeLeft}) - ${staff.workingHours}`
          ).join('\n');
          
          embed.addFields({ name: '🟢 Currently Working', value: activeStaffText });
        } else {
          embed.addFields({ name: '🟢 Currently Working', value: 'No team members are currently working.' });
        }
        
        // Add inactive staff field
        if (inactiveStaff.length > 0) {
          const inactiveStaffText = inactiveStaff.map(staff => 
            `${staff.name} - ${staff.workingHours}`
          ).join('\n');
          
          embed.addFields({ name: '⚪ Not Working', value: inactiveStaffText });
        }
        
        embed.setFooter({ text: 'All times are in Europe/Berlin timezone' });
        
        // Send the embed
        await interaction.editReply({ embeds: [embed] });
        
      } catch (error) {
        logToFile(`Error in /availability command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error displaying availability: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error displaying availability: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /analyze command
    else if (commandName === 'analyze') {
      try {
        // Get command options with defaults
        const messageCount = interaction.options.getInteger('messages') || 100;
        const dryRun = interaction.options.getBoolean('dry_run') || false;
        const ephemeral = interaction.options.getBoolean('ephemeral') !== false; // Default to true
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        
        // Check if channel is linked to a Notion page
        const channel = interaction.channel;
        if (!channel) {
          await interaction.editReply('❌ This command can only be used in a text channel.');
          return;
        }
        
        // Check permissions
        const permissions = channel.permissionsFor(interaction.client.user);
        if (!permissions || !permissions.has('ReadMessageHistory')) {
          await interaction.editReply('❌ I don\'t have permission to read message history in this channel. Please give me the "Read Message History" permission and try again.');
          return;
        }
        
        // Log the command
        logToFile(`/analyze command used in #${channel.name} for ${messageCount} messages by ${interaction.user.tag}`);
        
        // Check if Notion is configured
        if (!notion) {
          await interaction.editReply('❌ Notion integration is not configured. Please ask an administrator to set up the Notion API token and database ID.');
          return;
        }
        
        // Check if the channel name contains a project code (IB##, CL##, BC##)
        const channelName = channel.name.toLowerCase();
        const codeMatch = channelName.match(/(ib|cl|bc)\d{2}/i);
        
        if (!codeMatch) {
          await interaction.editReply('❌ This channel does not appear to be linked to a project. Channel name should contain a project code like IB23, CL45, etc.');
          return;
        }
        
        const projectCode = codeMatch[0].toUpperCase();
        
        // Find the project in Notion
        const project = await findProjectByQuery(projectCode);
        if (!project) {
          await interaction.editReply(`❌ Could not find project with code "${projectCode}" in Notion database.`);
          return;
        }
        
        // Get the page
        const page = project.page;
        
        // Fetch messages
        let messages;
        try {
          messages = await channel.messages.fetch({ limit: Math.min(messageCount, 100) });
          logToFile(`Fetched ${messages.size} messages from #${channel.name}`);
        } catch (fetchError) {
          await interaction.editReply(`❌ Error fetching messages: ${fetchError.message}`);
          return;
        }
        
        // If OpenAI is not configured, we can't analyze messages
        if (!openai) {
          await interaction.editReply('❌ OpenAI API is not configured. Please ask an administrator to set up the OpenAI API key.');
          return;
        }
        
        // Prepare messages for analysis
        const messageTexts = [...messages.values()]
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp) // Sort chronologically
          .map(msg => `${msg.author.tag}: ${msg.content}`)
          .join('\n');
        
        // Add context about what we're looking for
        const systemPrompt = `
          You are analyzing Discord messages from a video production project. 
          Extract the following properties from the conversation:
          
          1. Project status (e.g., Writing, Writing Review, VA Render, Ready for Editing, Clip Selection, MGX)
          2. Script link (Google Docs URL)
          3. Frame.io link
          4. Key dates mentioned (filming dates, delivery dates)
          5. Editor assignment
          6. Lead assignment
          7. Progress updates
          
          Format your response as a JSON object with these properties.
          Only include properties that are clearly mentioned in the messages.
        `;
        
        // Complete the prompt with extracted context
        let gptResponse;
        try {
          gptResponse = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: messageTexts }
            ],
            max_tokens: 1000
          });
          
          logToFile(`OpenAI analysis completed for ${projectCode}`);
        } catch (aiError) {
          logToFile(`OpenAI error: ${aiError.message}`);
          await interaction.editReply(`❌ Error analyzing messages: ${aiError.message}`);
          return;
        }
        
        // Extract completion
        const completion = gptResponse.choices[0]?.message?.content;
        if (!completion) {
          await interaction.editReply('❌ Error: No completion received from OpenAI.');
          return;
        }
        
        // Try to parse the JSON response
        let extractedData;
        try {
          // Extract JSON from the response (it might be wrapped in markdown code blocks)
          const jsonMatch = completion.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || 
                            completion.match(/(\{[\s\S]*\})/);
                            
          const jsonString = jsonMatch ? jsonMatch[1] : completion;
          extractedData = JSON.parse(jsonString);
          
          logToFile(`Successfully parsed JSON for ${projectCode}`);
        } catch (parseError) {
          logToFile(`JSON parse error: ${parseError.message}, raw: ${completion}`);
          await interaction.editReply(`❌ Error parsing extracted data: ${parseError.message}`);
          return;
        }
        
        // Format the extracted data for display
        const embed = new EmbedBuilder()
          .setTitle(`Analysis Results: ${projectCode}`)
          .setDescription(`Analyzed ${messages.size} messages in <#${channel.id}>`)
          .setColor(dryRun ? 0xFFAA00 : 0x00AAFF)
          .setTimestamp();
        
        // Add fields for each piece of data
        Object.entries(extractedData).forEach(([key, value]) => {
          if (value && value !== '') {
            embed.addFields({ name: key, value: String(value).substring(0, 1024) });
          }
        });
        
        // Add footer based on dry run status
        if (dryRun) {
          embed.setFooter({ text: '⚠️ DRY RUN - No changes were made to Notion' });
        } else {
          // Convert extracted data to Notion properties
          const propertiesToUpdate = {};
          
          // Map extracted data to Notion properties
          if (extractedData.status) {
            propertiesToUpdate['Status'] = {
              select: { name: extractedData.status }
            };
          }
          
          if (extractedData.script_link) {
            propertiesToUpdate['Script'] = {
              url: extractedData.script_link
            };
          }
          
          if (extractedData.frame_io_link) {
            propertiesToUpdate['Frame.io'] = {
              url: extractedData.frame_io_link
            };
          }
          
          if (extractedData.editor) {
            propertiesToUpdate['Editor'] = {
              multi_select: extractedData.editor.split(',').map(name => ({ name: name.trim() }))
            };
          }
          
          if (extractedData.lead) {
            propertiesToUpdate['Lead'] = {
              people: extractedData.lead.split(',').map(name => ({ name: name.trim() }))
            };
          }
          
          if (extractedData.due_date) {
            propertiesToUpdate['Date'] = {
              date: { start: extractedData.due_date }
            };
          }
          
          // Update Notion if not a dry run
          try {
            await notion.pages.update({
              page_id: page.id,
              properties: propertiesToUpdate
            });
            
            embed.setFooter({ text: '✅ Notion updated successfully' });
            logToFile(`Notion updated for ${projectCode} with properties: ${Object.keys(propertiesToUpdate).join(', ')}`);
          } catch (notionError) {
            logToFile(`Notion update error: ${notionError.message}`);
            embed.setFooter({ text: `❌ Error updating Notion: ${notionError.message}` });
          }
        }
        
        // Send the response
        await interaction.editReply({ embeds: [embed] });
        
      } catch (error) {
        logToFile(`Error in /analyze command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error analyzing messages: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error analyzing messages: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /link command
    else if (commandName === 'link') {
      try {
        // Check if ephemeral flag is set
        const ephemeral = interaction.options.getBoolean('ephemeral') !== false; // Default to true
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        
        // Check if channel is linked to a project
        const channel = interaction.channel;
        if (!channel) {
          await interaction.editReply('❌ This command can only be used in a text channel.');
          return;
        }
        
        // Check if the channel name contains a project code (IB##, CL##, BC##)
        const channelName = channel.name.toLowerCase();
        const codeMatch = channelName.match(/(ib|cl|bc)\d{2}/i);
        
        if (!codeMatch) {
          await interaction.editReply('❌ This channel does not appear to be linked to a project. Channel name should contain a project code like IB23, CL45, etc.');
          return;
        }
        
        const projectCode = codeMatch[0].toUpperCase();
        
        // Find the project in Notion
        const project = await findProjectByQuery(projectCode);
        if (!project) {
          await interaction.editReply(`❌ Could not find project with code "${projectCode}" in Notion database.`);
          return;
        }
        
        // Get the Notion URL
        const notionUrl = getNotionPageUrl(project.page.id);
        if (!notionUrl) {
          await interaction.editReply(`❌ Could not generate Notion URL for project "${projectCode}".`);
          return;
        }
        
        // Create button
        const linkButton = new ButtonBuilder()
          .setLabel('Open in Notion')
          .setStyle(ButtonStyle.Link)
          .setURL(notionUrl);
          
        const row = new ActionRowBuilder().addComponents(linkButton);
        
        // Create embed
        const embed = new EmbedBuilder()
          .setTitle(`Project: ${projectCode}`)
          .setDescription(`Here's the Notion link for project **${projectCode}**:`)
          .setColor(0x0099FF)
          .addFields({ name: 'Notion Link', value: notionUrl })
          .setTimestamp();
        
        // Send response
        await interaction.editReply({
          embeds: [embed],
          components: [row]
        });
        
      } catch (error) {
        logToFile(`Error in /link command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error finding Notion link: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error finding Notion link: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /sync command
    else if (commandName === 'sync') {
      try {
        // Get command options
        const text = interaction.options.getString('text');
        const dryRun = interaction.options.getBoolean('dry_run') || false;
        
        await interaction.deferReply();
        hasResponded = true;
        
        // Check if OpenAI is configured
        if (!openai) {
          await interaction.editReply('❌ OpenAI API is not configured. Please ask an administrator to set up the OpenAI API key.');
          return;
        }
        
        // Check if channel is linked to a project
        const channel = interaction.channel;
        if (!channel) {
          await interaction.editReply('❌ This command can only be used in a text channel.');
          return;
        }
        
        // Check if the channel name contains a project code
        const channelName = channel.name.toLowerCase();
        const codeMatch = channelName.match(/(ib|cl|bc)\d{2}/i);
        
        if (!codeMatch) {
          await interaction.editReply('❌ This channel does not appear to be linked to a project. Channel name should contain a project code like IB23, CL45, etc.');
          return;
        }
        
        const projectCode = codeMatch[0].toUpperCase();
        
        // Find the project in Notion
        const project = await findProjectByQuery(projectCode);
        if (!project) {
          await interaction.editReply(`❌ Could not find project with code "${projectCode}" in Notion database.`);
          return;
        }
        
        // Define system prompt with Notion property structure
        const systemPrompt = `
You are a helpful assistant that converts natural language descriptions into structured Notion properties.
Given text about a video project, extract relevant information and format it as a JSON object with 
properties that match the Notion database structure below.

NOTION DATABASE STRUCTURE:
1. Date Properties
   • Date (Date): Primary due date
   • Date for current stage (Date): Date for the current workflow stage

2. Category (Select)
   Options: CL, Bodycam, IB

3. Links (URL)
   • Script: URL to script document
   • Frame.io: URL to Frame.io project

4. People (Person)
   • Lead: Project lead person
   • Project Owner: Owner of the project
   • Editor: Editor assigned to the project
   • Writer: Writer assigned to the project

5. Pipeline Stage / Status (Select)
   Options: Backlog, FOIA Received, Ready for production, Writing, Writing Review, VA Render, 
   VA Review, Writing Revisions, Ready for Editing, Clip Selection, Clip Selection Review, 
   MGX, MGX Review/Cleanup, Ready to upload, Paused, TRIAL

6. 3D
   • 3D Status (Select): Current status of 3D elements
   • 3D Scenes (Text/URL): Details about 3D scenes

7. Captions
   • Caption Status (Select)
   Options: Ready For Captions, Captions In Progress, Captions Done

8. Language Versions (Each is a Select property)
   • Portuguese, Spanish, Russian, Indonesian
   Options for all: Done, Fixing Notes, In Progress, QC, Approved for dub, Uploaded

INSTRUCTIONS:
1. Extract only relevant information from the user's message.
2. Return a JSON object with Notion property keys and values.
3. Only include properties mentioned in the message.
4. Format dates in ISO format (YYYY-MM-DD).
5. For select fields, use exact option names from the list provided.
6. If unsure about a property, don't include it rather than guessing.

Example Input: "Change status to Clip Selection and set the editor to Sarah and due date to next Friday"
Example Output: {
  "Status": "Clip Selection",
  "Editor": "Sarah",
  "Date": "2023-06-02"
}
`;
        
        logToFile(`Processing sync for ${projectCode}: "${text}"`);
        
        // Send to GPT-4o for processing
        const response = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
          ],
          temperature: 0.1, // Low temperature for more deterministic output
          max_tokens: 1000
        });
        
        // Get the completion
        const completion = response.choices[0]?.message?.content;
        if (!completion) {
          await interaction.editReply('❌ Error: No response received from AI.');
          return;
        }
        
        // Parse the JSON response
        let properties;
        try {
          // Extract JSON from the response (it might be wrapped in markdown code blocks)
          const jsonMatch = completion.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || 
                          completion.match(/(\{[\s\S]*\})/);
                          
          const jsonString = jsonMatch ? jsonMatch[1] : completion;
          properties = JSON.parse(jsonString);
          
          logToFile(`Successfully parsed properties for ${projectCode}: ${JSON.stringify(properties)}`);
        } catch (parseError) {
          logToFile(`JSON parse error: ${parseError.message}, raw response: ${completion}`);
          await interaction.editReply(`❌ Error parsing AI response: ${parseError.message}`);
          return;
        }
        
        // Convert extracted properties to Notion format
        const notionProperties = {};
        
        // Map properties to Notion format
        for (const [key, value] of Object.entries(properties)) {
          if (!value || value === '') continue;
          
          // Handle different property types
          switch (key) {
            case 'Status':
            case 'Caption Status':
            case 'Category':
            case '3D Status':
              notionProperties[key] = { select: { name: value } };
              break;
              
            case 'Portuguese':
            case 'Spanish':
            case 'Russian':
            case 'Indonesian':
              notionProperties[key] = { select: { name: value } };
              break;
              
            case 'Date':
            case 'Date for current stage':
              notionProperties[key] = { date: { start: value } };
              break;
              
            case 'Script':
            case 'Frame.io':
            case 'Discord Channel':
              if (value.startsWith('http')) {
                notionProperties[key] = { url: value };
              } else {
                notionProperties[key] = { rich_text: [{ text: { content: value } }] };
              }
              break;
              
            case 'Lead':
            case 'Project Owner':
            case 'Editor':
            case 'Writer':
              // For person properties, we need to handle both single names and arrays
              const people = Array.isArray(value) ? value : [value];
              notionProperties[key] = { 
                people: people.map(name => ({ name }))
              };
              break;
              
            case 'Change Log 1':
            case 'Text':
            case '3D Scenes':
              notionProperties[key] = { 
                rich_text: [{ text: { content: value } }]
              };
              break;
              
            default:
              // For any other property, try to guess the type based on the value
              if (typeof value === 'string') {
                if (value.startsWith('http')) {
                  notionProperties[key] = { url: value };
                } else {
                  notionProperties[key] = { 
                    rich_text: [{ text: { content: value } }]
                  };
                }
              }
          }
        }
        
        // Create embed for display
        const embed = new EmbedBuilder()
          .setTitle(`Sync Results: ${projectCode}`)
          .setDescription(dryRun ? '⚠️ DRY RUN - Preview only, no changes made' : '✅ Notion will be updated with these properties')
          .setColor(dryRun ? 0xFFAA00 : 0x00AAFF)
          .setTimestamp();
        
        // Add fields for each property
        Object.entries(properties).forEach(([key, value]) => {
          const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
          embed.addFields({ name: key, value: displayValue.substring(0, 1024), inline: true });
        });
        
        // Update Notion if not a dry run
        if (!dryRun) {
          try {
            await notion.pages.update({
              page_id: project.page.id,
              properties: notionProperties
            });
            
            logToFile(`Notion updated for ${projectCode} with properties: ${Object.keys(notionProperties).join(', ')}`);
            embed.setFooter({ text: '✅ Notion updated successfully' });
          } catch (notionError) {
            logToFile(`Notion update error: ${notionError.message}`);
            embed.setFooter({ text: `❌ Error updating Notion: ${notionError.message}` });
          }
        } else {
          embed.setFooter({ text: '⚠️ DRY RUN - No changes were made to Notion' });
        }
        
        // Send response
        await interaction.editReply({ embeds: [embed] });
        
      } catch (error) {
        logToFile(`Error in /sync command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error syncing with Notion: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error syncing with Notion: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /set command
    else if (commandName === 'set') {
      try {
        await interaction.deferReply({ ephemeral: true });
        hasResponded = true;
        
        // Check if channel is linked to a project
        const channel = interaction.channel;
        if (!channel) {
          await interaction.editReply('❌ This command can only be used in a text channel.');
          return;
        }
        
        // Check if the channel name contains a project code
        const channelName = channel.name.toLowerCase();
        const codeMatch = channelName.match(/(ib|cl|bc)\d{2}/i);
        
        if (!codeMatch) {
          await interaction.editReply('❌ This channel does not appear to be linked to a project. Channel name should contain a project code like IB23, CL45, etc.');
          return;
        }
        
        const projectCode = codeMatch[0].toUpperCase();
        
        // Find the project in Notion
        const project = await findProjectByQuery(projectCode);
        if (!project) {
          await interaction.editReply(`❌ Could not find project with code "${projectCode}" in Notion database.`);
          return;
        }
        
        // Get subcommand and value
        const subcommand = interaction.options.getSubcommand();
        const value = interaction.options.getString('value');
        
        // Process based on subcommand
        logToFile(`Processing /set ${subcommand} for project ${projectCode}: "${value}"`);
        
        // Prepare Notion properties object
        const notionProperties = {};
        
        // Set the appropriate property based on the subcommand
        switch (subcommand) {
          case 'status':
            notionProperties['Status'] = { select: { name: value } };
            break;
            
          case 'caption_status':
            notionProperties['Caption Status'] = { select: { name: value } };
            break;
            
          case 'category':
            notionProperties['Category'] = { select: { name: value } };
            break;
            
          case 'date':
            try {
              // Try to parse the date
              const date = new Date(value);
              if (isNaN(date.getTime())) {
                throw new Error('Invalid date format');
              }
              notionProperties['Date'] = { date: { start: date.toISOString().split('T')[0] } };
            } catch (e) {
              await interaction.editReply(`❌ Invalid date format: "${value}". Please use a valid date format (e.g., "2023-05-15" or "May 15, 2023").`);
              return;
            }
            break;
            
          case 'script':
            if (!value.startsWith('http')) {
              await interaction.editReply('❌ Script value must be a valid URL starting with http:// or https://');
              return;
            }
            notionProperties['Script'] = { url: value };
            break;
            
          case 'frameio':
            if (!value.startsWith('http')) {
              await interaction.editReply('❌ Frame.io value must be a valid URL starting with http:// or https://');
              return;
            }
            notionProperties['Frame.io'] = { url: value };
            break;
            
          case 'lead':
            notionProperties['Lead'] = { people: [{ name: value }] };
            break;
            
          case 'editor':
            notionProperties['Editor'] = { people: [{ name: value }] };
            break;
            
          case 'writer':
            notionProperties['Writer'] = { people: [{ name: value }] };
            break;
            
          case '3d_status':
            notionProperties['3D Status'] = { select: { name: value } };
            break;
            
          case 'language':
            // Handle language subcommand with additional parameter
            const language = interaction.options.getString('language');
            const languageStatus = value;
            
            if (!['Portuguese', 'Spanish', 'Russian', 'Indonesian'].includes(language)) {
              await interaction.editReply('❌ Invalid language. Must be one of: Portuguese, Spanish, Russian, Indonesian');
              return;
            }
            
            notionProperties[language] = { select: { name: languageStatus } };
            break;
            
          default:
            await interaction.editReply(`❌ Unknown subcommand: ${subcommand}`);
            return;
        }
        
        try {
          // Update the Notion page
          await notion.pages.update({
            page_id: project.page.id,
            properties: notionProperties
          });
          
          // Get the Notion URL for the page
          const notionUrl = getNotionPageUrl(project.page.id);
          
          // Create components with button if there's a Notion URL
          const components = [];
          if (notionUrl) {
            const row = new ActionRowBuilder()
              .addComponents(
                new ButtonBuilder()
                  .setLabel('View in Notion')
                  .setStyle(ButtonStyle.Link)
                  .setURL(notionUrl)
              );
            components.push(row);
          }
          
          // Success message
          await interaction.editReply({
            content: `✅ Updated ${subcommand.replace(/_/g, ' ')} to "${value}" for project ${projectCode}`,
            components: components.length > 0 ? components : undefined
          });
          
          // Also send a non-ephemeral message to channel for visibility
          await interaction.channel.send(
            `✅ <@${interaction.user.id}> set ${subcommand.replace(/_/g, ' ')} to "${value}" for project ${projectCode}`
          );
          
        } catch (updateError) {
          logToFile(`Error updating property in /set command: ${updateError.message}`);
          await interaction.editReply(`❌ Error updating property: ${updateError.message}`);
        }
        
      } catch (error) {
        logToFile(`Error in /set command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error setting property: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error setting property: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /help command
    else if (commandName === 'help') {
      try {
        // Create embed
        const embed = new EmbedBuilder()
          .setTitle('Insanity Discord Bot Help')
          .setDescription('Here are the available commands and how to use them:')
          .setColor(0x0099FF)
          .addFields(
            { name: '/where [query]', value: 'Find project info by code or name. Shows links, status, and people.' },
            { name: '/availability', value: 'See who is currently working and their remaining time.' },
            { name: '/link', value: 'Get the Notion link for the current channel\'s project.' },
            { name: '/analyze [messages]', value: 'Analyze recent messages to extract project info and update Notion.' },
            { name: '/sync [text]', value: 'Update Notion with properties from your text (format: "Status: Ready, Editor: Name").' },
            { name: '/schedule [task]', value: 'Schedule a task or reminder for the channel.' },
            { name: '/help', value: 'Show this help message.' }
          )
          .setFooter({ text: 'Use the ephemeral option on commands to make responses only visible to you' })
          .setTimestamp();
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
        hasResponded = true;
        
      } catch (error) {
        logToFile(`Error in /help command: ${error.message}`);
        if (!hasResponded) {
          await interaction.reply({ content: `❌ Error displaying help: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /schedule command
    else if (commandName === 'schedule') {
      try {
        // Check if ephemeral flag is set
        const ephemeral = interaction.options.getBoolean('ephemeral') !== false; // Default to true
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        
        // Create and send the schedule embed
        const embed = createScheduleEmbed();
        await interaction.editReply({ embeds: [embed] });
        
      } catch (error) {
        logToFile(`Error in /schedule command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error displaying schedule: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error displaying schedule: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle other commands here
    // ...
    
  } catch (error) {
    // Global error handling
    logToFile(`Uncaught error in command ${commandName}: ${error.message}`);
    logToFile(error.stack);
    
    try {
      // Try to notify the user if possible
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ 
          content: '❌ An unexpected error occurred. Please try again later.',
          ephemeral: true 
        });
      } else {
        await interaction.followUp({ 
          content: '❌ An unexpected error occurred. Please try again later.',
          ephemeral: true 
        });
      }
    } catch (notifyError) {
      logToFile(`Failed to notify user about error: ${notifyError.message}`);
    }
  }
});

// Log in to Discord
client.login(TOKEN).catch(error => {
  console.error('Failed to log in to Discord:', error);
  logToFile(`Login error: ${error.message}`);
  process.exit(1);
});

// Export the client for testing
module.exports = { client, notion, findProjectByQuery, getNotionPageUrl };

// Function to schedule all jobs
function scheduleAllJobs() {
  // Clear any existing jobs
  for (const job of activeJobs.values()) {
    job.stop();
  }
  activeJobs.clear();
  
  // Schedule each job
  jobs.forEach(job => {
    // Ensure timezone is properly set
    const options = {
      timezone: TZ,
      scheduled: true
    };
    
    // Schedule the new job
    const scheduledJob = cron.schedule(job.cron, () => {
      // Log the execution with timestamp
      const berlinTime = new Date().toLocaleString('en-US', { timeZone: TZ });
      logToFile(`⏰ Executing job: ${job.tag} at ${berlinTime} (${TZ} time)`);
      
      // Send the message
      ping(job.text);
    }, options);
    
    activeJobs.set(job.tag, scheduledJob);
    logToFile(`Scheduled job: ${job.tag} (${job.cron} in ${TZ} timezone)`);
    
    // Log next execution time
    const nextExecution = getNextExecution(job.cron);
    if (nextExecution) {
      logToFile(`   → Next execution: ${nextExecution.formatted} (in ${nextExecution.formattedTimeLeft})`);
    }
  });
  
  logToFile(`Total jobs scheduled: ${activeJobs.size}`);
}
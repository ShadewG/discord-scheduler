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
  { tag: 'Social Fika', cron: '0 9 * * 1-5', text: `☕ <@&${TEAM_ROLE_ID}> **Social Fika** - Casual check-in + daily sync (9:00-9:20).`, notify: true },
  { tag: 'Deep Work AM', cron: '20 9 * * 1-5', text: `🧠 <@&${TEAM_ROLE_ID}> **Deep Work** starts now — focus mode ON (9:20-11:00).` },
  { tag: 'Fika Break', cron: '0 11 * * 1-5', text: `🍪 <@&${TEAM_ROLE_ID}> **Fika Break** - Short break time! (11:00-11:20)`, notify: true },
  { tag: 'Deep Work Continue', cron: '20 11 * * 1-5', text: `🧠 <@&${TEAM_ROLE_ID}> **Deep Work** continues — back to focused mode (11:20-13:00).` },
  { tag: 'Lunch Break', cron: '0 13 * * 1-5', text: `🍽️ <@&${TEAM_ROLE_ID}> **Lunch break** — enjoy! Back at 13:45.`, notify: true },
  { tag: 'Planning Huddle', cron: '45 13 * * 1-5', text: `📋 <@&${TEAM_ROLE_ID}> **Planning Huddle** - Quick team sync (13:45-14:00).`, notify: true },
  { tag: 'Deep Work PM', cron: '0 14 * * 1-5', text: `🧠 <@&${TEAM_ROLE_ID}> **Deep Work PM** - Project execution and reviews (14:00-17:00).` },
  { tag: 'Wrap-Up Meeting', cron: '0 17 * * 1-5', text: `👋 <@&${TEAM_ROLE_ID}> **Wrap-Up Meeting** - Daily summary + vibes check for the day (17:00-17:30).`, notify: true }
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
    
    // Format the time as HH:MM
    const formattedHour = hour.toString().padStart(2, '0');
    const formattedMinute = minute.toString().padStart(2, '0');
    
    return {
      tag: `${job.tag} Notification`,
      cron: notifyCron,
      text: `🔔 <@&${TEAM_ROLE_ID}> Heads-up — **${meetingName}** in 5 minutes (${formattedHour}:${formattedMinute}).`,
      isNotification: true
    };
  });

// Combine regular jobs and notification jobs
jobs = [...jobs, ...notificationJobs];

// Function to validate all cron expressions
function validateCronExpressions() {
  logToFile('Validating cron expressions...');
  
  const now = new Date();
  const currentDayOfWeek = now.getDay(); // 0 is Sunday, 1 is Monday, etc.
  logToFile(`Current day of week: ${currentDayOfWeek} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][currentDayOfWeek]})`);
  
  let allValid = true;
  
  jobs.forEach((job, index) => {
    try {
      // Simple validation - check parts
      const parts = job.cron.split(' ');
      if (parts.length !== 5) {
        logToFile(`❌ Job ${index + 1}: ${job.tag} - Invalid cron expression format: ${job.cron}`);
        allValid = false;
        return;
      }
      
      // Check if job should run on current day
      const dayOfWeekPart = parts[4];
      let shouldRunToday = false;
      
      if (dayOfWeekPart === '*') {
        shouldRunToday = true;
      } else if (dayOfWeekPart.includes(',')) {
        // Handle comma-separated days (e.g., "1,3,5")
        const days = dayOfWeekPart.split(',').map(Number);
        shouldRunToday = days.includes(currentDayOfWeek);
      } else if (dayOfWeekPart.includes('-')) {
        // Handle range of days (e.g., "1-5")
        const [start, end] = dayOfWeekPart.split('-').map(Number);
        shouldRunToday = currentDayOfWeek >= start && currentDayOfWeek <= end;
      } else {
        // Single day
        shouldRunToday = Number(dayOfWeekPart) === currentDayOfWeek;
      }
      
      // Try to create a scheduler to validate the expression
      const scheduler = cron.schedule(job.cron, () => {}, { scheduled: false });
      scheduler.stop();
      
      const status = shouldRunToday ? '✅ Should run today' : '⚠️ Not scheduled for today';
      logToFile(`${status} - Job ${index + 1}: ${job.tag} (${job.cron})`);
      
    } catch (error) {
      logToFile(`❌ Job ${index + 1}: ${job.tag} - Error validating cron expression: ${error.message}`);
      allValid = false;
    }
  });
  
  if (allValid) {
    logToFile('✅ All cron expressions are valid');
  } else {
    logToFile('❌ Some cron expressions have issues - check logs');
  }
  
  return allValid;
}

// Helper function to get the next execution time for a cron expression
function getNextExecution(cronExpression) {
  try {
    // Log the cron expression for debugging
    logToFile(`Calculating next execution for cron: ${cronExpression}`);
    
    // Get current time
    const now = new Date();
    
    // Parse the cron expression
    const parts = cronExpression.split(' ');
    if (parts.length !== 5) {
      throw new Error('Invalid cron expression format');
    }
    
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    
    // Calculate the next execution time using a simple approach
    // For our scheduled workday jobs, we can make some simplifying assumptions
    
    // Create a future date starting from today
    let nextDate = new Date();
    nextDate.setSeconds(0); // Reset seconds
    nextDate.setMilliseconds(0); // Reset milliseconds
    
    // For most workday schedules, we're dealing with specific hour/minute
    // combinations on certain days of the week
    
    // Set the hour and minute
    let targetHour = parseInt(hour);
    let targetMinute = parseInt(minute);
    
    // Handle wildcards and ranges
    if (hour === '*') targetHour = now.getHours();
    if (minute === '*') targetMinute = now.getMinutes() + 1; // Next minute if current is wildcard
    
    nextDate.setHours(targetHour);
    nextDate.setMinutes(targetMinute);
    
    // If this time has already passed today, move to tomorrow
    if (nextDate <= now) {
      nextDate.setDate(nextDate.getDate() + 1);
    }
    
    // Check if the day of week matches
    const currentDayOfWeek = nextDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
    
    // For day of week patterns like "1-5" (weekdays)
    let validDays = [];
    if (dayOfWeek === '*') {
      validDays = [0, 1, 2, 3, 4, 5, 6]; // All days are valid
    } else if (dayOfWeek.includes('-')) {
      // Handle ranges like 1-5
      const [start, end] = dayOfWeek.split('-').map(Number);
      for (let i = start; i <= end; i++) {
        validDays.push(i);
      }
    } else if (dayOfWeek.includes(',')) {
      // Handle lists like 1,3,5
      validDays = dayOfWeek.split(',').map(Number);
    } else {
      // Single day
      validDays = [parseInt(dayOfWeek)];
    }
    
    // If current day isn't valid, find the next valid day
    if (!validDays.includes(currentDayOfWeek)) {
      let daysToAdd = 1;
      let nextDayOfWeek = (currentDayOfWeek + 1) % 7;
      
      while (!validDays.includes(nextDayOfWeek) && daysToAdd < 7) {
        daysToAdd++;
        nextDayOfWeek = (nextDayOfWeek + 1) % 7;
      }
      
      nextDate.setDate(nextDate.getDate() + daysToAdd);
      
      // Reset time to the target hour/minute
      nextDate.setHours(targetHour);
      nextDate.setMinutes(targetMinute);
    }
    
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
    const formattedTimeLeft = `${hours}h ${minutes}m ${seconds}s`;
    
    // Log successful calculation
    logToFile(`Next execution for ${cronExpression}: ${formatted} (in ${formattedTimeLeft})`);
    
    return { 
      date: nextDate, 
      formatted, 
      timeLeft: { hours, minutes, seconds },
      formattedTimeLeft 
    };
  } catch (error) {
    console.error(`Error calculating next execution: ${error.message}`);
    logToFile(`Error calculating next execution for cron "${cronExpression}": ${error.message}\n${error.stack}`);
    return null;
  }
}

// Function to create schedule embed
function createScheduleEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0x00AAFF)
    .setTitle('Daily Work Schedule')
    .setDescription(`Current time in ${TZ}: **${moment().tz(TZ).format('dddd, MMM D, HH:mm:ss')}**\nThis schedule shows all upcoming reminders and events.`)
    .setTimestamp();

  // Process jobs for display
  const upcomingJobs = [];
  const regularJobs = [];
  
  // Only process non-notification jobs for display in the regular schedule
  const displayJobs = jobs.filter(job => !job.isNotification);
  
  // Log the number of jobs being processed
  logToFile(`Creating schedule embed. Total jobs: ${jobs.length}, Display jobs (non-notification): ${displayJobs.length}`);
  
  // Log each job for debugging
  displayJobs.forEach((job, index) => {
    logToFile(`Job ${index + 1}: ${job.tag} (${job.cron})`);
  });
  
  displayJobs.forEach(job => {
    const nextExecution = getNextExecution(job.cron);
    if (!nextExecution) {
      logToFile(`Failed to get next execution for job: ${job.tag} (${job.cron})`);
      return;
    }
    
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
      logToFile(`Added to upcoming jobs: ${job.tag} (${job.cron}) - in ${nextExecution.formattedTimeLeft}`);
    } else {
      regularJobs.push(jobInfo);
      logToFile(`Added to regular jobs: ${job.tag} (${job.cron}) - in ${nextExecution.formattedTimeLeft}`);
    }
  });
  
  // Log summary of processed jobs
  logToFile(`Processed jobs summary: Upcoming=${upcomingJobs.length}, Regular=${regularJobs.length}`);
  
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
      
      // Format message text - remove any @Schedule mentions and trim
      const messageText = job.text.replace('@Schedule', '').trim();
      
      embed.addFields({ 
        name: `${index + 1}. ${job.tag} (${hour}:${minute})`, 
        value: `⏱️ **Countdown:** ${job.timeUntil}\n🕒 **At:** ${job.formatted}\n\n📝 **Message:**\n${messageText}`
      });
    });
  } else {
    embed.addFields({ 
      name: '⏰ UPCOMING SCHEDULE EVENTS', 
      value: '*No events scheduled in the next 12 hours*'
    });
  }
  
  // Add full day schedule
  embed.addFields({ 
    name: '📅 DAILY SCHEDULE (Mon-Fri)', 
    value: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  });
  
  if (regularJobs.length > 0) {
    regularJobs.forEach((job) => {
      // Extract hour and minute from cron for readability
      const cronParts = job.cronExpr.split(' ');
      const hour = cronParts[1].padStart(2, '0');
      const minute = cronParts[0].padStart(2, '0');
      
      // Format message text - remove any @Schedule mentions and trim
      const messageText = job.text.replace('@Schedule', '').trim();
      
      embed.addFields({ 
        name: `${hour}:${minute} — ${job.tag}`, 
        value: messageText
      });
    });
  } else {
    embed.addFields({ 
      name: 'No Regular Jobs', 
      value: '*No regular daily events configured*'
    });
  }
  
  embed.setFooter({ text: `All times are in ${TZ} timezone • Use the Refresh button to update countdowns` });
  
  return embed;
}

// Load environment variables
const TOKEN = process.env.DISCORD_TOKEN;
const NOTION_KEY = process.env.NOTION_TOKEN || process.env.NOTION_KEY; // Support both naming conventions
const DB = process.env.NOTION_DATABASE_ID || process.env.NOTION_DB_ID; // Support both naming conventions
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GUILD_ID = process.env.GUILD_ID;

// Status watchers configuration
const STATUS_WATCHERS = [
  {
    status: "MGX Review/Cleanup",
    userId: "348547268695162890",
    message: "This project might be ready for dubbing, check with the leads"
  }
  // Additional watchers can be added in the future
];

// Log environment variables for debugging (without showing full values)
console.log('Environment variables check:');
console.log(`- DISCORD_TOKEN: ${TOKEN ? '✅ Set' : '❌ Missing'}`);
console.log(`- NOTION_KEY: ${NOTION_KEY ? '✅ Set' : '❌ Missing'}`);
console.log(`- NOTION_DATABASE_ID: ${DB ? `✅ Set (${DB.substring(0, 6)}...)` : '❌ Missing'}`);
console.log(`- OPENAI_API_KEY: ${OPENAI_API_KEY ? '✅ Set' : '❌ Missing'}`);

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
async function ping(message) {
  try {
    // Log that we're attempting to send a message
    logToFile(`Attempting to send schedule message: ${message}`);
    
    // Find the Schedule channel by ID
    const channel = client.channels.cache.get(SCHEDULE_CHANNEL_ID);
    
    if (channel) {
      // Log channel details
      logToFile(`Found channel #${channel.name} (${channel.id})`);
      
      // Check permissions
      const permissions = channel.permissionsFor(client.user);
      if (!permissions) {
        logToFile(`ERROR: Cannot check permissions for channel #${channel.name}`);
        return null;
      } else if (!permissions.has('SendMessages')) {
        logToFile(`ERROR: Bot doesn't have 'Send Messages' permission in #${channel.name}`);
        return null;
      } else if (!permissions.has('MentionEveryone')) {
        logToFile(`⚠️ WARNING: Bot doesn't have 'Mention Everyone' permission in #${channel.name}`);
        logToFile(`This may prevent the bot from mentioning roles!`);
        // Continue anyway since we can still send messages
      }
      
      // Fix: Use await to properly wait for the message to be sent
      try {
        const sentMessage = await channel.send(message);
        logToFile(`✅ Successfully sent schedule message to #${channel.name}: ${message}`);
        return sentMessage;
      } catch (err) {
        logToFile(`❌ Error sending message to #${channel.name}: ${err.message}`);
        console.error(`Failed to send message to #${channel.name}:`, err);
        throw err; // Re-throw to handle it in the calling function
      }
    } else {
      logToFile(`❌ ERROR: Could not find schedule channel with ID ${SCHEDULE_CHANNEL_ID}`);
      console.error(`Could not find schedule channel with ID ${SCHEDULE_CHANNEL_ID}`);
      
      // Log all available channels for debugging
      logToFile('Available channels:');
      client.channels.cache.forEach(ch => {
        logToFile(`- ${ch.id}: #${ch.name || 'unnamed'} (${ch.type})`);
      });
      return null;
    }
  } catch (error) {
    logToFile(`❌ Critical error in ping function: ${error.message}`);
    console.error('Critical error in ping function:', error);
    throw error; // Re-throw to handle it in the calling function
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
    console.log(`  - Using database ID: ${DB.substring(0, 8)}...`);
    
    // Store the database ID in global scope for access in functions
    global.NOTION_DATABASE_ID = DB;
  } else {
    if (!NOTION_KEY) console.warn('⚠️ NOTION_KEY not provided. Notion features will be disabled.');
    if (!DB) console.warn('⚠️ NOTION_DATABASE_ID not provided. Notion features will be disabled.');
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
  try {
    if (!notion) {
      logToFile('Notion client not initialized');
      return null;
    }
    
    // Get database ID from environment variable or global variable - ensure it's defined
    const databaseId = process.env.NOTION_DATABASE_ID || process.env.NOTION_DB_ID || global.NOTION_DATABASE_ID || DB;
    
    if (!databaseId) {
      logToFile('ERROR: Notion database ID is undefined. Check your environment variables.');
      console.error('❌ ERROR: Notion database ID is undefined. Check your environment variables.');
      return null;
    }
    
    // Trim the query
    query = query.trim();
    
    // If query is empty, return null
    if (!query) {
      logToFile('Empty query');
      return null;
    }
    
    // Direct ID lookup (if query is a valid UUID)
    if (query.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      try {
        logToFile(`Looking up page by direct ID: ${query}`);
        const page = await notion.pages.retrieve({ page_id: query });
        
        // Extract name and code from title
        const name = page.properties["Project name"]?.title?.[0]?.plain_text || "Unknown";
        const codeFromName = name.match(/(ib|cl|bc)\d{2}/i);
        const code = codeFromName ? codeFromName[0].toUpperCase() : "";
        
        return { page, name, code };
      } catch (error) {
        logToFile(`Error retrieving page by ID: ${error.message}`);
      }
    }
    
    // Extract code pattern if it exists (e.g., IB23, CL45)
    const codeMatch = query.match(/(ib|cl|bc)\d{2}/i);
    const queryCode = codeMatch ? codeMatch[0].toUpperCase() : null;
    
    logToFile(`Querying Notion database for: "${query}" with database ID: ${databaseId.substring(0, 8)}...`);
    
    // Try different approaches to find the project
    let response;
    
    // IMPORTANT: Use "Project name" as the property name, not "Name"
    if (queryCode) {
      logToFile(`Found code pattern in query: ${queryCode}, searching by Project name property`);
      
      // Search by Project name property containing the code
      response = await notion.databases.query({
        database_id: databaseId,
        filter: {
          property: "Project name",
          title: {
            contains: queryCode
          }
        },
        page_size: 10
      });
      
      logToFile(`Found ${response.results.length} results with Project name containing "${queryCode}"`);
      
      // If no results, try with just the prefix (IB, CL, BC)
      if (response.results.length === 0) {
        const prefix = queryCode.substring(0, 2); // Get just the prefix (IB, CL, BC)
        
        logToFile(`No results with exact code, trying prefix "${prefix}" in Project name property`);
        
        response = await notion.databases.query({
          database_id: databaseId,
          filter: {
            property: "Project name",
            title: {
              contains: prefix
            }
          },
          page_size: 20
        });
        
        logToFile(`Found ${response.results.length} results with Project name containing prefix "${prefix}"`);
      }
    } else {
      // If no code pattern, just search by name containing the query
      response = await notion.databases.query({
        database_id: databaseId,
        filter: {
          property: "Project name",
          title: {
            contains: query
          }
        },
        page_size: 10
      });
      
      logToFile(`Found ${response.results.length} results with Project name containing general query "${query}"`);
    }
    
    // If no results, return null
    if (response.results.length === 0) {
      logToFile(`No projects found for query: "${query}"`);
      return null;
    }
    
    // Get the first result
    const page = response.results[0];
    
    // Extract name from the page properties - use "Project name" not "Name"
    const name = page.properties["Project name"]?.title?.[0]?.plain_text || "Unknown";
    
    // Extract code from the name
    const codeFromName = name.match(/(ib|cl|bc)\d{2}/i);
    const code = codeFromName ? codeFromName[0].toUpperCase() : "";
    
    // Log available properties
    logToFile(`Project found: ${name} (extracted code: ${code})`);
    logToFile(`Properties available: ${Object.keys(page.properties).join(', ')}`);
    
    // Ensure we have a valid page.id before returning
    if (!page.id) {
      logToFile(`Error: No valid page.id found for project ${name}`);
      return null;
    }
    
    // Return the project
    return {
      page: page,
      name: name,
      code: code
    };
    
  } catch (error) {
    logToFile(`Error finding project: ${error.message}`);
    console.error(`Error finding project: ${error.message}`);
    return null;
  }
}

// Function to fetch Notion database schema details
async function fetchDatabaseSchema() {
  if (!notion || !DB) {
    logToFile('Cannot fetch database schema: Notion client or database ID not initialized');
    return null;
  }
  
  try {
    logToFile(`Fetching database schema for database ID: ${DB}`);
    const response = await notion.databases.retrieve({ database_id: DB });
    
    if (!response || !response.properties) {
      logToFile('Invalid response or no properties found in database schema');
      return null;
    }
    
    // Extract property information
    const properties = {};
    
    for (const [propName, propDetails] of Object.entries(response.properties)) {
      properties[propName] = {
        type: propDetails.type,
        name: propName
      };
      
      // For select properties, extract the options
      if (propDetails.type === 'select' && propDetails.select?.options) {
        properties[propName].options = propDetails.select.options.map(opt => opt.name);
      }
      
      // For multi-select properties, extract the options
      if (propDetails.type === 'multi_select' && propDetails.multi_select?.options) {
        properties[propName].options = propDetails.multi_select.options.map(opt => opt.name);
      }
    }
    
    logToFile(`Successfully fetched database schema with ${Object.keys(properties).length} properties`);
    return properties;
  } catch (error) {
    logToFile(`Error fetching database schema: ${error.message}`);
    return null;
  }
}

// Call this function once at startup to cache the schema
let notionSchema = null;

// After the findProjectByQuery function, add:

// Helper function to find the best matching property name
function findBestPropertyMatch(propertyPage, targetName) {
  if (!propertyPage || !targetName) return null;
  
  // Try exact match first
  if (propertyPage[targetName]) {
    return targetName;
  }
  
  // Try case-insensitive match (exact spelling but different case)
  const caseInsensitiveMatch = Object.keys(propertyPage).find(
    propName => propName.toLowerCase() === targetName.toLowerCase()
  );
  
  if (caseInsensitiveMatch) {
    logToFile(`Found case-insensitive match for "${targetName}": "${caseInsensitiveMatch}"`);
    return caseInsensitiveMatch;
  }
  
  // Try fuzzy match (contains the target name)
  const fuzzyMatches = Object.keys(propertyPage).filter(
    propName => propName.toLowerCase().includes(targetName.toLowerCase())
  );
  
  if (fuzzyMatches.length === 1) {
    logToFile(`Found fuzzy match for "${targetName}": "${fuzzyMatches[0]}"`);
    return fuzzyMatches[0];
  } else if (fuzzyMatches.length > 1) {
    logToFile(`Found multiple fuzzy matches for "${targetName}": ${fuzzyMatches.join(', ')}`);
    // Return the closest match
    return fuzzyMatches[0]; // Take the first one for now
  }
  
  // No match found
  return null;
}

// When the client is ready, run this code
client.once('ready', () => {
  console.log('Bot is ready!');
  logToFile('Bot started successfully');
  
  // Verify schedule channel access
  const scheduleChannel = client.channels.cache.get(SCHEDULE_CHANNEL_ID);
  if (!scheduleChannel) {
    console.error(`❌ ERROR: Schedule channel with ID ${SCHEDULE_CHANNEL_ID} not found!`);
    logToFile(`❌ CRITICAL ERROR: Schedule channel with ID ${SCHEDULE_CHANNEL_ID} not found!`);
    logToFile('Available text channels:');
    client.channels.cache.forEach(ch => {
      if (ch.type === 0) { // Text channels
        logToFile(`- ${ch.id}: #${ch.name} (${ch.guild.name})`);
      }
    });
  } else {
    console.log(`✅ Found schedule channel: #${scheduleChannel.name}`);
    logToFile(`✅ Found schedule channel: #${scheduleChannel.name} in server ${scheduleChannel.guild.name}`);
    
    // Check permissions
    const permissions = scheduleChannel.permissionsFor(client.user);
    if (!permissions) {
      console.error('❌ Cannot check permissions for the schedule channel');
      logToFile('❌ Cannot check permissions for the schedule channel');
    } else {
      const requiredPermissions = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];
      const missingPermissions = requiredPermissions.filter(perm => !permissions.has(perm));
      
      if (missingPermissions.length > 0) {
        console.error(`❌ Missing permissions for schedule channel: ${missingPermissions.join(', ')}`);
        logToFile(`❌ Missing permissions for schedule channel: ${missingPermissions.join(', ')}`);
      } else {
        console.log('✅ Bot has all required permissions for the schedule channel');
        logToFile('✅ Bot has all required permissions for the schedule channel');
        
        // Check specifically for mention permissions
        if (!permissions.has('MentionEveryone')) {
          console.warn('⚠️ Bot does not have permission to mention @everyone, @here, or roles');
          logToFile('⚠️ Bot does not have permission to mention @everyone, @here, or roles');
          logToFile('This may prevent role mentions from working properly in scheduled messages');
          logToFile('To fix this, give the bot the "Mention @everyone, @here, and All Roles" permission');
        } else {
          console.log('✅ Bot has permission to mention roles');
          logToFile('✅ Bot has permission to mention roles');
        }
        
        // Create a test message with a role mention but don't send it
        const testMessage = `🤖 Bot startup test: This is a test message with role mention <@&${TEAM_ROLE_ID}>`;
        logToFile(`Test message format with role mention: ${testMessage}`);
        logToFile('✅ Startup checks complete - no test message sent to avoid channel spam');
      }
    }
  }
  
  // Log the jobs array for debugging
  logToFile(`Initial jobs array contains ${jobs.length} jobs:`);
  jobs.forEach((job, index) => {
    logToFile(`  ${index + 1}. ${job.tag} (${job.cron}): ${job.text.substring(0, 50)}${job.text.length > 50 ? '...' : ''}`);
  });
  
  // Validate cron expressions
  validateCronExpressions();
  
  // Fetch Notion database schema if Notion is configured
  if (notion && DB) {
    fetchDatabaseSchema().then(schema => {
      notionSchema = schema;
      if (schema) {
        logToFile('Notion database schema loaded successfully');
        
        // Log available properties and their types
        Object.entries(schema).forEach(([name, details]) => {
          const optionsInfo = details.options ? 
            ` with ${details.options.length} options: ${details.options.join(', ')}` : '';
          logToFile(`- Property "${name}" (${details.type})${optionsInfo}`);
        });
      }
    });
  }
  
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
  
  // Check next execution times
  checkAllNextExecutionTimes();
  
  // Start a health check interval to monitor the schedule system
  startScheduleHealthCheck();
});

// Function to perform a regular health check on the schedule
function startScheduleHealthCheck() {
  setTimeout(() => {
    // Verify that all jobs are scheduled
    logToFile(`Schedule health check: activeJobs.size=${activeJobs.size}, expected=${jobs.length}`);
    
    if (activeJobs.size < jobs.length) {
      logToFile(`⚠️ Schedule health check: ${jobs.length - activeJobs.size} jobs not scheduled. Re-scheduling all jobs.`);
      scheduleAllJobs();
    }
  }, 5000); // After 5 seconds
}

// Function to check status and trigger notifications
async function checkStatusAndNotify(projectCode, newStatus, channelId) {
  try {
    logToFile(`Checking status watchers for project ${projectCode} with status "${newStatus}"`);
    
    // Find watchers that match this status
    const matchingWatchers = STATUS_WATCHERS.filter(watcher => 
      watcher.status.toLowerCase() === newStatus.toLowerCase());
    
    if (matchingWatchers.length === 0) {
      logToFile(`No status watchers found for status "${newStatus}"`);
      return;
    }
    
    logToFile(`Found ${matchingWatchers.length} matching watchers for status "${newStatus}"`);
    
    // If we don't have a channel ID, we can't send a notification
    if (!channelId) {
      logToFile(`No channel ID provided, can't send notification for project ${projectCode}`);
      return;
    }
    
    // Find the channel
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
      logToFile(`Could not find channel with ID ${channelId} for project ${projectCode}`);
      return;
    }
    
    // Send a notification for each matching watcher
    for (const watcher of matchingWatchers) {
      try {
        const message = `<@${watcher.userId}> ${watcher.message}`;
        logToFile(`Sending status notification to user ${watcher.userId} in channel #${channel.name}`);
        
        await channel.send(message);
        logToFile(`Successfully sent status notification for ${projectCode} to user ${watcher.userId}`);
      } catch (error) {
        logToFile(`Error sending status notification: ${error.message}`);
      }
    }
  } catch (error) {
    logToFile(`Error in checkStatusAndNotify: ${error.message}`);
  }
}

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
        await interaction.deferReply({ flags: ephemeral ? [1 << 6] : [] });
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
        
        // Find the status property using the best match function
        let status = 'No Status';
        const statusPropertyName = findBestPropertyMatch(properties, 'Status');
        if (statusPropertyName && properties[statusPropertyName]?.select?.name) {
          status = properties[statusPropertyName].select.name;
          logToFile(`Found status using property name: "${statusPropertyName}"`);
        } else {
          // Fallback to old method for backwards compatibility
          if (properties.Status?.select?.name) {
            status = properties.Status.select.name;
          } else if (properties.status?.select?.name) {
            status = properties.status.select.name;
          } else {
            // Log all property names for debugging
            logToFile(`Available properties for ${code}: ${Object.keys(properties).join(', ')}`);
          }
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
        
        await interaction.deferReply({ flags: ephemeral ? [1 << 6] : [] });
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
        
        await interaction.deferReply({ flags: ephemeral ? [1 << 6] : [] });
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
          logToFile(`Attempting to fetch ${Math.min(messageCount, 100)} messages from #${channel.name}`);
          messages = await channel.messages.fetch({ limit: Math.min(messageCount, 100) });
          logToFile(`Fetched ${messages.size} messages from #${channel.name}`);
        } catch (fetchError) {
          logToFile(`Error fetching messages: ${fetchError.message}`);
          await interaction.editReply(`❌ Error fetching messages: ${fetchError.message}. Make sure the bot has the "Read Message History" permission in this channel.`);
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
              status: { name: extractedData.status }
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
            
            // Get Notion URL for button
            const notionUrl = getNotionPageUrl(page.id);
            
            embed.setFooter({ text: '✅ Notion updated successfully' });
            
            // Create button component if there's a Notion URL
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
            
            // Send the response with the button
            await interaction.editReply({ 
              embeds: [embed],
              components: components.length > 0 ? components : undefined
            });
            
            logToFile(`Notion updated for ${projectCode} with properties: ${Object.keys(propertiesToUpdate).join(', ')}`);
          } catch (notionError) {
            logToFile(`Notion update error: ${notionError.message}`);
            embed.setFooter({ text: `❌ Error updating Notion: ${notionError.message}` });
            await interaction.editReply({ embeds: [embed] });
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
        
        await interaction.deferReply({ flags: ephemeral ? [1 << 6] : [] });
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
        
        await interaction.deferReply({ flags: ephemeral ? [1 << 6] : [] });
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
          
          // Find the best matching property name in the page properties
          const bestMatch = findBestPropertyMatch(project.page.properties, key);
          const propertyKey = bestMatch || key;
          
          // Handle different property types
          switch (key) {
            case 'Status':
              // Status is a status type property, not a select
              notionProperties[propertyKey] = { status: { name: value } };
              break;
              
            case 'Caption Status':
            case 'Category':
            case '3D Status':
              notionProperties[propertyKey] = { select: { name: value } };
              break;
              
            case 'Portuguese':
            case 'Spanish':
            case 'Russian':
            case 'Indonesian':
              notionProperties[propertyKey] = { select: { name: value } };
              break;
              
            case 'Date':
            case 'Date for current stage':
              notionProperties[propertyKey] = { date: { start: value } };
              break;
              
            case 'Script':
            case 'Frame.io':
            case 'Discord Channel':
              if (value.startsWith('http')) {
                notionProperties[propertyKey] = { url: value };
              } else {
                notionProperties[propertyKey] = { rich_text: [{ text: { content: value } }] };
              }
              break;
              
            case 'Lead':
            case 'Project Owner':
            case 'Editor':
            case 'Writer':
              // For person properties, we need to handle both single names and arrays
              const people = Array.isArray(value) ? value : [value];
              notionProperties[propertyKey] = { 
                people: people.map(name => ({ name }))
              };
              break;
              
            case 'Change Log 1':
            case 'Text':
            case '3D Scenes':
              notionProperties[propertyKey] = { 
                rich_text: [{ text: { content: value } }]
              };
              break;
              
            default:
              // For any other property, try to guess the type based on the value
              if (typeof value === 'string') {
                if (value.startsWith('http')) {
                  notionProperties[propertyKey] = { url: value };
                } else {
                  notionProperties[propertyKey] = { 
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
            // Log the properties object for debugging
            logToFile(`Updating Notion page with properties: ${JSON.stringify(notionProperties)}`);
            logToFile(`Page ID: ${project.page.id}`);
            
            // Log the available properties on the page for debugging
            const pageProperties = project.page.properties;
            const availableProps = Object.keys(pageProperties);
            logToFile(`Available properties on the page: ${availableProps.join(', ')}`);
            
            // If setting status, log detailed information
            if (subcommand === 'status') {
              // Check status watchers and send notifications if needed
              checkStatusAndNotify(projectCode, value, channel.id);
              
              // Try multiple variations of the property name
              const possibleNames = ['Status', 'status', 'STATUS'];
              
              possibleNames.forEach(propName => {
                if (pageProperties[propName]) {
                  logToFile(`Found Status property as "${propName}": ${JSON.stringify(pageProperties[propName])}`);
                } else {
                  logToFile(`Property "${propName}" does not exist on the page`);
                }
              });
              
              // Find any property that looks like a status property
              const statusLikeProps = availableProps.filter(prop => 
                prop.toLowerCase().includes('status')
              );
              
              if (statusLikeProps.length > 0) {
                logToFile(`Found status-like properties: ${statusLikeProps.join(', ')}`);
                statusLikeProps.forEach(prop => {
                  logToFile(`Details for "${prop}": ${JSON.stringify(pageProperties[prop])}`);
                });
              }
            }
            
            // Update the Notion page
            logToFile(`Sending update to Notion API: ${JSON.stringify({
              page_id: project.page.id,
              properties: notionProperties
            })}`);
            
            await notion.pages.update({
              page_id: project.page.id,
              properties: notionProperties
            });
            
            // Get Notion URL for page
            const notionUrl = getNotionPageUrl(project.page.id);
            
            logToFile(`Notion updated for ${projectCode} with properties: ${Object.keys(notionProperties).join(', ')}`);
            embed.setFooter({ text: '✅ Notion updated successfully' });
            
            // Create button component if there's a Notion URL
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
            
            // Send the response with button
            await interaction.editReply({ 
              embeds: [embed],
              components: components.length > 0 ? components : undefined
            });
            
          } catch (notionError) {
            logToFile(`Notion update error: ${notionError.message}`);
            embed.setFooter({ text: `❌ Error updating Notion: ${notionError.message}` });
            await interaction.editReply({ embeds: [embed] });
          }
        } else {
          embed.setFooter({ text: '⚠️ DRY RUN - No changes were made to Notion' });
          await interaction.editReply({ embeds: [embed] });
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
        
        // For status changes, check the status watchers
        if (subcommand === 'status') {
          // Check if we need to trigger status watchers
          checkStatusAndNotify(projectCode, value, channel.id);
        }
        
        // Continue with the existing code...
        
        // For any property update, try to find the best property name match
        if (subcommand === 'status' || subcommand === 'caption_status' || subcommand === 'category') {
          // Get the page properties
          const pageProperties = project.page.properties;
          
          // Normalize expected property name based on subcommand
          let propertyNameToFind = '';
          if (subcommand === 'status') {
            propertyNameToFind = 'Status';
          } else if (subcommand === 'caption_status') {
            propertyNameToFind = 'Caption Status';
          } else if (subcommand === 'category') {
            propertyNameToFind = 'Category';
          }
          
          // Find the best property match - log all property names for debugging
          logToFile(`Available property names: ${Object.keys(pageProperties).join(', ')}`);
          
          const bestMatch = findBestPropertyMatch(pageProperties, propertyNameToFind);
          
          if (bestMatch) {
            logToFile(`Using best match property name: "${bestMatch}" for "${propertyNameToFind}"`);
            notionProperties[bestMatch] = { select: { name: value } };
            
            // Log extra debugging info about the property
            logToFile(`Property details: ${JSON.stringify(pageProperties[bestMatch])}`);
            
            try {
              // Update the Notion page
              await notion.pages.update({
                page_id: project.page.id, // Use the actual page ID from the page object
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
                content: `✅ Updated ${subcommand.replace(/_/g, ' ')} to "${value}" for project ${projectCode} using property name "${bestMatch}"`,
                components: components.length > 0 ? components : undefined
              });
              
              // Also send a non-ephemeral message to channel for visibility
              await interaction.channel.send(
                `✅ <@${interaction.user.id}> set ${subcommand.replace(/_/g, ' ')} to "${value}" for project ${projectCode}`
              );
              
              // Skip the rest of the function since we've handled it
              return;
            } catch (updateError) {
              logToFile(`Error updating property using best match: ${updateError.message}`);
              // Continue to switch statement as fallback
            }
          } else {
            logToFile(`No matching property found for "${propertyNameToFind}"`);
          }
        }
        
        // Set the appropriate property based on the subcommand
        switch (subcommand) {
          case 'status':
            // Use schema information if available
            if (notionSchema) {
              // Find the right property name from schema
              const statusProperty = Object.keys(notionSchema).find(propName =>
                propName.toLowerCase() === 'status' && 
                (notionSchema[propName].type === 'status' || notionSchema[propName].type === 'select')
              );
              
              if (statusProperty) {
                logToFile(`Using exact property name from schema: "${statusProperty}" (type: ${notionSchema[statusProperty].type})`);
                // Check if it's a status type or select type
                if (notionSchema[statusProperty].type === 'status') {
                  notionProperties[statusProperty] = { status: { name: value } };
                } else {
                  notionProperties[statusProperty] = { select: { name: value } };
                }
              } else {
                // Default to "Status" with status type
                logToFile('Status property not found in schema, using "Status" with status type');
                notionProperties['Status'] = { status: { name: value } };
              }
            } else {
              // Default to "Status" with status type
              notionProperties['Status'] = { status: { name: value } };
            }
            break;
            
          case 'caption_status':
            // Similar approach for caption_status
            if (notionSchema) {
              const captionStatusProperty = Object.keys(notionSchema).find(propName =>
                propName.toLowerCase() === 'caption status' && 
                notionSchema[propName].type === 'select'
              );
              
              if (captionStatusProperty) {
                logToFile(`Using exact property name from schema: "${captionStatusProperty}"`);
                notionProperties[captionStatusProperty] = { select: { name: value } };
              } else {
                notionProperties['Caption Status'] = { select: { name: value } };
              }
            } else {
              notionProperties['Caption Status'] = { select: { name: value } };
            }
            break;
            
          case 'category':
            if (notionSchema) {
              const categoryProperty = Object.keys(notionSchema).find(propName =>
                propName.toLowerCase() === 'category' && 
                notionSchema[propName].type === 'select'
              );
              
              if (categoryProperty) {
                logToFile(`Using exact property name from schema: "${categoryProperty}"`);
                notionProperties[categoryProperty] = { select: { name: value } };
              } else {
                notionProperties['Category'] = { select: { name: value } };
              }
            } else {
              notionProperties['Category'] = { select: { name: value } };
            }
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
          // Log the properties object for debugging
          logToFile(`Updating Notion page with properties: ${JSON.stringify(notionProperties)}`);
          logToFile(`Page ID: ${project.page.id}`);
          
          // Log the available properties on the page for debugging
          const pageProperties = project.page.properties;
          const availableProps = Object.keys(pageProperties);
          logToFile(`Available properties on the page: ${availableProps.join(', ')}`);
          
          // If setting status, log detailed information
          if (subcommand === 'status') {
            // Try multiple variations of the property name
            const possibleNames = ['Status', 'status', 'STATUS'];
            
            possibleNames.forEach(propName => {
              if (pageProperties[propName]) {
                logToFile(`Found Status property as "${propName}": ${JSON.stringify(pageProperties[propName])}`);
              } else {
                logToFile(`Property "${propName}" does not exist on the page`);
              }
            });
            
            // Find any property that looks like a status property
            const statusLikeProps = availableProps.filter(prop => 
              prop.toLowerCase().includes('status')
            );
            
            if (statusLikeProps.length > 0) {
              logToFile(`Found status-like properties: ${statusLikeProps.join(', ')}`);
              statusLikeProps.forEach(prop => {
                logToFile(`Details for "${prop}": ${JSON.stringify(pageProperties[prop])}`);
              });
            }
          }
          
          // Update the Notion page
          logToFile(`Sending update to Notion API: ${JSON.stringify({
            page_id: project.page.id, // Use the actual page ID
            properties: notionProperties
          })}`);
          
          await notion.pages.update({
            page_id: project.page.id, // Use the actual page ID
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
        
        await interaction.deferReply({ flags: ephemeral ? [1 << 6] : [] });
        hasResponded = true;
        
        // Create and send the schedule embed
        const scheduleEmbed = createScheduleEmbed();
        
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('refresh_schedule')
              .setLabel('Refresh Timers')
              .setStyle(ButtonStyle.Primary),
          );
        
        await interaction.editReply({
          content: '📅 Here is the complete schedule with countdown timers:',
          embeds: [scheduleEmbed],
          components: [row]
        });
        
      } catch (error) {
        logToFile(`Error in /schedule command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error displaying schedule: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error displaying schedule: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /send command
    else if (commandName === 'send') {
      try {
        // Get command options
        const messageType = interaction.options.getString('message_type');
        const isNotification = interaction.options.getBoolean('notification') || false;
        
        await interaction.deferReply({ ephemeral: true });
        hasResponded = true;
        
        // Find the job with the matching tag
        let jobToSend = null;
        
        if (isNotification) {
          // Look for the notification job
          jobToSend = jobs.find(job => job.tag === `${messageType} Notification`);
        } else {
          // Look for the main job
          jobToSend = jobs.find(job => job.tag === messageType);
        }
        
        if (!jobToSend) {
          await interaction.editReply(`❌ Could not find a job with the tag "${messageType}${isNotification ? ' Notification' : ''}".`);
          return;
        }
        
        // Send the message using the ping function
        ping(jobToSend.text);
        
        logToFile(`Manually sent message for job: ${jobToSend.tag}`);
        
        await interaction.editReply({
          content: `✅ Successfully sent the ${isNotification ? 'notification for' : ''} "${messageType}" message.`,
          components: []
        });
        
      } catch (error) {
        logToFile(`Error in /send command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error sending message: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error sending message: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /meeting command
    else if (commandName === 'meeting') {
      try {
        // Get command options
        const title = interaction.options.getString('title') || 'Team Meeting';
        const time = interaction.options.getString('time');
        const description = interaction.options.getString('description') || '';
        const usersString = interaction.options.getString('users') || '';
        
        await interaction.deferReply({ flags: [1 << 6] });
        hasResponded = true;
        
        // Extract user IDs from the users string
        const mentionedUserIds = [];
        const userMatches = usersString.matchAll(/<@!?(\d+)>/g);
        for (const match of userMatches) {
          mentionedUserIds.push(match[1]);
        }
        
        // If no users were mentioned, mention the person who created the meeting
        if (mentionedUserIds.length === 0) {
          mentionedUserIds.push(interaction.user.id);
        }
        
        // Try to parse the date
        let meetingDate = null;
        
        // Try GPT first if available
        if (openai) {
          logToFile(`Trying to parse date with GPT: "${time}"`);
          meetingDate = await parseDate(time);
          logToFile(`GPT parsed date: ${meetingDate}`);
        }
        
        // Fall back to manual parsing if GPT fails
        if (!meetingDate) {
          logToFile(`Trying to parse date manually: "${time}"`);
          meetingDate = manualDateParse(time);
          logToFile(`Manually parsed date: ${meetingDate}`);
        }
        
        // If date parsing failed, return an error
        if (!meetingDate) {
          await interaction.editReply(`❌ Could not parse the time: "${time}". Please use a more standard format like "tomorrow at 3pm" or "in 30m".`);
          return;
        }
        
        // Check if the date is in the past
        const now = new Date();
        if (meetingDate < now) {
          await interaction.editReply(`❌ The meeting time is in the past. Please choose a future time.`);
          return;
        }
        
        // Generate a meeting ID
        const meetingId = nextMeetingId++;
        
        // Schedule the meeting
        const { formattedDate } = scheduleMeeting(
          meetingId,
          interaction.channel.id,
          meetingDate,
          mentionedUserIds,
          title,
          description
        );
        
        // Create the user mentions string for the response
        const mentionsString = mentionedUserIds.map(userId => `<@${userId}>`).join(' ');
        
        // Send confirmation message
        const embed = new EmbedBuilder()
          .setTitle(`🗓️ Meeting Scheduled: ${title}`)
          .setColor(0x00AAFF)
          .setDescription(description || 'No description provided')
          .addFields(
            { name: 'Time', value: formattedDate, inline: true },
            { name: 'Participants', value: mentionsString || 'No participants', inline: true },
            { name: 'Meeting ID', value: `#${meetingId}`, inline: true }
          )
          .setFooter({ text: 'A reminder will be sent 5 minutes before the meeting' })
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
        
        // Send notification to channel
        await interaction.channel.send(
          `🆕 <@${interaction.user.id}> scheduled a meeting **${title}** for ${formattedDate} with ${mentionsString}`
        );
        
      } catch (error) {
        logToFile(`Error in /meeting command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error scheduling meeting: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error scheduling meeting: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /changelog command
    else if (commandName === 'changelog') {
      try {
        // Get command options
        const projectCode = interaction.options.getString('project');
        const ephemeral = interaction.options.getBoolean('ephemeral') !== false; // Default to true
        
        await interaction.deferReply({ flags: ephemeral ? [1 << 6] : [] });
        hasResponded = true;
        
        // Check if Notion is configured
        if (!notion) {
          await interaction.editReply('❌ Notion integration is not configured. Please ask an administrator to set up the Notion API token and database ID.');
          return;
        }
        
        // Determine which project to look up
        let targetProjectCode = projectCode;
        
        // If no project specified, try to get from channel name
        if (!targetProjectCode) {
          const channelName = interaction.channel.name.toLowerCase();
          const codeMatch = channelName.match(/(ib|cl|bc)\d{2}/i);
          
          if (codeMatch) {
            targetProjectCode = codeMatch[0].toUpperCase();
          } else {
            await interaction.editReply('❌ Please specify a project code or use this command in a project-specific channel.');
            return;
          }
        }
        
        // Find the project in Notion
        const project = await findProjectByQuery(targetProjectCode);
        if (!project) {
          await interaction.editReply(`❌ Could not find project with code "${targetProjectCode}" in Notion database.`);
          return;
        }
        
        logToFile(`Fetching changelog for project ${targetProjectCode}`);
        
        try {
          // Basic information about the project
          let statusChanges = [];
          const page = project.page;
          
          // Get the current status if available
          let currentStatus = "Unknown";
          if (page.properties.Status && page.properties.Status.status && page.properties.Status.status.name) {
            currentStatus = page.properties.Status.status.name;
            statusChanges.push({
              status: currentStatus,
              date: new Date(page.last_edited_time),
              by: 'Current'
            });
          }
          
          // Query for all pages related to this project that have status changes
          // We'll search for pages with the project code in their title
          // Use specific database ID for changelog
          const changelogDbId = "1d987c20070a80b9aacce39262b5da60";
          logToFile(`Searching for status changes in changelog database ${changelogDbId} for project ${targetProjectCode}`);
          
          const response = await notion.databases.query({
            database_id: changelogDbId,
            filter: {
              property: "Title",
              title: {
                contains: targetProjectCode
              }
            },
            sorts: [
              {
                property: "Changed At",
                direction: "ascending"
              }
            ],
            page_size: 100
          });
          
          logToFile(`Found ${response.results.length} pages matching project ${targetProjectCode}`);
          
          // Extract status changes from all pages
          for (const relatedPage of response.results) {
            if (relatedPage.id === page.id) {
              // Skip the main page as we already processed it
              continue;
            }
            
            try {
              // Try to extract status from properties
              let pageStatus = null;
              // Try different property names for Status
              const statusProps = ["New Status", "Status", "status", "Stage", "Pipeline Stage"];
              
              for (const propName of statusProps) {
                if (relatedPage.properties[propName] && 
                  (relatedPage.properties[propName].status?.name || 
                    relatedPage.properties[propName].select?.name)) {
                  pageStatus = relatedPage.properties[propName].status?.name || 
                             relatedPage.properties[propName].select?.name;
                  break;
                }
              }
              
              if (pageStatus) {
                statusChanges.push({
                  status: pageStatus,
                  date: new Date(relatedPage.properties["Changed At"]?.date?.start || relatedPage.created_time),
                  page: relatedPage,
                  id: relatedPage.id
                });
              }
            } catch (error) {
              logToFile(`Error processing related page: ${error.message}`);
              // Continue with other pages
            }
          }
          
          // Go through properties to find potential status dates
          for (const [key, value] of Object.entries(page.properties)) {
            // Look for date properties that might indicate status changes
            if (value.type === 'date' && value.date) {
              if (key.toLowerCase().includes('date') || 
                  key.toLowerCase().includes('time') || 
                  key.toLowerCase().includes('changed') || 
                  key.toLowerCase().includes('updated')) {
                
                // Try to extract a status from the property name
                const statusMatch = key.match(/^(.*?)\s*(?:date|time|changed|updated)/i);
                if (statusMatch && statusMatch[1].trim()) {
                  statusChanges.push({
                    status: statusMatch[1].trim(),
                    date: new Date(value.date.start),
                    by: 'From Property'
                  });
                  continue;
                }
              }
            }
            
            // Check for rich text properties that may contain changelog info
            if (value.type === 'rich_text' && value.rich_text.length > 0 &&
               (key.toLowerCase().includes('history') || 
                key.toLowerCase().includes('changelog') || 
                key.toLowerCase().includes('log'))) {
              
              const text = value.rich_text.map(t => t.plain_text).join('');
              // Split into separate entries (by newline or semicolon)
              const entries = text.split(/[\n;]/);
              
              for (const entry of entries) {
                if (!entry.trim()) continue;
                
                // Try to find date-status or status-date patterns
                const dateStatusMatch = entry.match(/(\d{4}-\d{2}-\d{2}|\w+ \d{1,2},?\s+\d{4})[\s:]+([A-Za-z\s/]+)/i);
                const statusDateMatch = entry.match(/([A-Za-z\s/]+)[\s:\(]+(\d{4}-\d{2}-\d{2}|\w+ \d{1,2},?\s+\d{4})/i);
                
                if (dateStatusMatch) {
                  try {
                    statusChanges.push({
                      status: dateStatusMatch[2].trim(),
                      date: new Date(dateStatusMatch[1]),
                      by: 'From Text'
                    });
                  } catch (e) {
                    logToFile(`Error parsing date: ${dateStatusMatch[1]}`);
                  }
                } else if (statusDateMatch) {
                  try {
                    statusChanges.push({
                      status: statusDateMatch[1].trim(),
                      date: new Date(statusDateMatch[2]),
                      by: 'From Text'
                    });
                  } catch (e) {
                    logToFile(`Error parsing date: ${statusDateMatch[2]}`);
                  }
                }
              }
            }
          }
          
          // If we still have no status changes, create a basic history
          if (statusChanges.length === 0) {
            statusChanges.push({
              status: 'Created',
              date: new Date(page.properties["Changed At"]?.date?.start || page.created_time),
              by: 'System'
            });
            
            // If we have an update time different from create time, add that
            if (page.last_edited_time !== page.created_time) {
              const currentStatus = page.properties.Status?.status?.name || 'Updated';
              statusChanges.push({
                status: currentStatus,
                date: new Date(page.last_edited_time),
                by: 'Current'
              });
            }
          }
          
          // Sort changes by date
          statusChanges.sort((a, b) => a.date - b.date);
          
          // Remove duplicates (same status in sequence)
          const uniqueChanges = [];
          let lastStatus = null;
          
          for (const change of statusChanges) {
            if (change.status !== lastStatus) {
              uniqueChanges.push(change);
              lastStatus = change.status;
            }
          }
          
          statusChanges = uniqueChanges;
          
          // If we still have no status changes, inform the user
          if (statusChanges.length === 0) {
            await interaction.editReply(`No status change history found for project ${targetProjectCode}.`);
            return;
          }
          
          // Calculate days between changes
          for (let i = 1; i < statusChanges.length; i++) {
            const prevDate = statusChanges[i-1].date;
            const currDate = statusChanges[i].date;
            const diffDays = Math.round((currDate - prevDate) / (1000 * 60 * 60 * 24));
            statusChanges[i].daysSincePrevious = diffDays;
          }
          
          // Get project name
          const projectName = page.properties["Title"]?.title?.[0]?.plain_text 
                           || page.properties["Project name"]?.title?.[0]?.plain_text 
                           || targetProjectCode;
          
          // Create an embed to display the changelog
          const embed = new EmbedBuilder()
            .setTitle(`📋 Changelog for ${targetProjectCode}`)
            .setColor(0x0099FF)
            .setDescription(`Status history for **${projectName}**\n\n**Current Status:** ${currentStatus}`)
            .setTimestamp();
          
          // Format dates
          const formatDate = (date) => {
            return date.toLocaleDateString('en-US', { 
              month: 'short', 
              day: 'numeric',
              year: 'numeric'
            });
          };
          
          // Create a detailed timeline view
          let timelineText = '';
          
          // Add fields for each status change
          statusChanges.forEach((change, index) => {
            const formattedDate = formatDate(change.date);
            const daysInfo = change.daysSincePrevious ? 
              ` (${change.daysSincePrevious} day${change.daysSincePrevious !== 1 ? 's' : ''})` : 
              '';
            
            const statusBar = index > 0 ? '↓ ' + '─'.repeat(5) + daysInfo + '\n' : '';
            timelineText += `${statusBar}**${index + 1}. ${change.status}** - ${formattedDate}\n`;
            
            // Add additional details if available (limit to first 8 changes to avoid hitting character limits)
            if (index < 8) {
              embed.addFields({
                name: `${index + 1}. ${change.status}`,
                value: `📅 ${formattedDate}${daysInfo}`
              });
            }
          });
          
          // If there are more than 8 changes, add a note
          if (statusChanges.length > 8) {
            embed.addFields({
              name: `+${statusChanges.length - 8} more changes`,
              value: `See timeline for complete history`
            });
          }
          
          // Add the timeline as a separate field
          if (statusChanges.length > 1) {
            embed.addFields({
              name: '⏳ Complete Timeline',
              value: timelineText.substring(0, 1024) // Discord field value limit
            });
          }
          
          // Calculate total days in pipeline
          if (statusChanges.length >= 2) {
            const firstDate = statusChanges[0].date;
            const lastDate = statusChanges[statusChanges.length - 1].date;
            const totalDays = Math.round((lastDate - firstDate) / (1000 * 60 * 60 * 24));
            
            embed.addFields({
              name: '⏱️ Total Time in Pipeline',
              value: `${totalDays} day${totalDays !== 1 ? 's' : ''}`
            });
          }
          
          // Calculate average days per stage
          if (statusChanges.length > 2) {
            const totalDaysTracked = statusChanges.reduce((sum, change) => 
              sum + (change.daysSincePrevious || 0), 0);
            const stages = statusChanges.length - 1; // Number of transitions
            const avgDays = (totalDaysTracked / stages).toFixed(1);
            
            embed.addFields({
              name: '📊 Average Time Per Stage',
              value: `${avgDays} days`
            });
          }
          
          // Get Notion URL for button
          const notionUrl = getNotionPageUrl(page.id);
          
          // Create button component if there's a Notion URL
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
          
          // Send the response
          await interaction.editReply({
            embeds: [embed],
            components: components.length > 0 ? components : undefined
          });
          
        } catch (notionError) {
          logToFile(`Error fetching changelog: ${notionError.message}`);
          await interaction.editReply(`❌ Error fetching changelog: ${notionError.message}`);
        }
        
      } catch (error) {
        logToFile(`Error in /changelog command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error displaying changelog: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error displaying changelog: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /test_schedule command
    else if (commandName === 'test_schedule') {
      try {
        await interaction.deferReply({ ephemeral: true });
        hasResponded = true;
        
        const messageType = interaction.options.getString('message_type') || 'Social Fika';
        const removeTag = interaction.options.getBoolean('remove_tag') || false;
        
        // Find the job
        const job = jobs.find(j => j.tag === messageType);
        
        if (!job) {
          await interaction.editReply(`❌ No job found with tag "${messageType}". Available tags: ${jobs.map(j => j.tag).join(', ')}`);
          return;
        }
        
        logToFile(`=== TEST SCHEDULE EXECUTION ===`);
        logToFile(`Manually testing schedule message for "${messageType}"`);
        logToFile(`Channel ID: ${SCHEDULE_CHANNEL_ID}`);
        
        // Check if the channel exists
        const channel = client.channels.cache.get(SCHEDULE_CHANNEL_ID);
        if (!channel) {
          logToFile(`❌ Channel with ID ${SCHEDULE_CHANNEL_ID} not found!`);
          await interaction.editReply(`❌ Channel with ID ${SCHEDULE_CHANNEL_ID} not found! Please check your .env configuration.`);
          
          // Log all available channels
          logToFile('Available text channels:');
          const availableChannels = client.channels.cache
            .filter(ch => ch.type === 0) // Text channels
            .map(ch => `${ch.id}: #${ch.name}`);
          
          logToFile(availableChannels.join('\n'));
          await interaction.editReply(`❌ Channel not found. Available text channels:\n${availableChannels.join('\n')}`);
          return;
        }
        
        // Test permissions
        const permissions = channel.permissionsFor(client.user);
        if (!permissions) {
          await interaction.editReply(`❌ Cannot check permissions for channel #${channel.name}`);
          return;
        }
        
        if (!permissions.has('SendMessages')) {
          await interaction.editReply(`❌ Bot doesn't have 'Send Messages' permission in #${channel.name}`);
          return;
        }
        
        // Create message text, with option to remove @Schedule tag
        let messageText = job.text;
        if (removeTag) {
          messageText = job.text.replace('@Schedule', '').trim();
          logToFile(`Testing with @Schedule tag removed: "${messageText}"`);
        }
        
        // First, let's also try without any formatting to see if that's the issue
        try {
          // Try sending a plain, simple message first
          const plainMessage = `Testing schedule system: ${messageType}`;
          logToFile(`First sending a plain test message: "${plainMessage}"`);
          
          const plainResult = await channel.send(plainMessage);
          logToFile(`✅ Plain test message sent successfully, ID: ${plainResult.id}`);
          
          // Now try the actual schedule message
          logToFile(`Now sending the actual schedule message: "${messageText}"`);
          const result = await ping(messageText);
          
          await interaction.editReply(`✅ Test messages sent successfully to #${channel.name}. Check the channel and logs.`);
        } catch (sendError) {
          await interaction.editReply(`❌ Error sending message: ${sendError.message}`);
        }
      } catch (error) {
        logToFile(`Error in /test_schedule command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error: ${error.message}`, ephemeral: true });
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

// Handle button interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  
  try {
    if (interaction.customId === 'refresh_schedule') {
      const scheduleEmbed = createScheduleEmbed();
      
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('refresh_schedule')
            .setLabel('Refresh Timers')
            .setStyle(ButtonStyle.Primary),
        );
      
      await interaction.update({
        content: '📅 Here is the complete schedule with countdown timers:',
        embeds: [scheduleEmbed],
        components: [row]
      });
      
      logToFile(`Schedule timers refreshed by ${interaction.user.tag}`);
    }
  } catch (error) {
    logToFile(`Error handling button interaction: ${error.message}`);
    await interaction.reply({ 
      content: '❌ Error refreshing schedule timers. Please try again.',
      ephemeral: true 
    });
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
  logToFile('=== Scheduling All Jobs ===');
  
  // Clear any existing jobs
  const existingJobCount = activeJobs.size;
  logToFile(`Clearing ${existingJobCount} existing jobs`);
  
  for (const job of activeJobs.values()) {
    job.stop();
  }
  activeJobs.clear();
  
  // Log jobs array before scheduling
  logToFile(`Preparing to schedule ${jobs.length} jobs`);
  
  // Schedule each job
  jobs.forEach(job => {
    // Ensure timezone is properly set
    const options = {
      timezone: TZ,
      scheduled: true
    };
    
    // Schedule the new job
    try {
      logToFile(`Scheduling job: ${job.tag} (${job.cron})`);
      
      const scheduledJob = cron.schedule(job.cron, async () => {
        // Log the execution with timestamp
        const berlinTime = new Date().toLocaleString('en-US', { timeZone: TZ });
        logToFile(`⏰ Executing job: ${job.tag} at ${berlinTime} (${TZ} time)`);
        logToFile(`Message to send: ${job.text}`);
        
        // Send the message with better error handling
        try {
          const sentMessage = await ping(job.text);
          if (sentMessage) {
            logToFile(`✅ Job ${job.tag} executed successfully, message ID: ${sentMessage.id}`);
          } else {
            logToFile(`⚠️ Job ${job.tag} did not return a sent message - likely failed`);
          }
        } catch (error) {
          logToFile(`❌ Error executing job ${job.tag}: ${error.message}`);
        }
      }, options);
      
      activeJobs.set(job.tag, scheduledJob);
      logToFile(`Successfully scheduled job: ${job.tag} (${job.cron} in ${TZ} timezone)`);
      
      // Log next execution time
      const nextExecution = getNextExecution(job.cron);
      if (nextExecution) {
        logToFile(`   → Next execution: ${nextExecution.formatted} (in ${nextExecution.formattedTimeLeft})`);
      } else {
        logToFile(`   → Failed to calculate next execution time for job: ${job.tag}`);
      }
    } catch (error) {
      logToFile(`ERROR scheduling job ${job.tag}: ${error.message}`);
      console.error(`Failed to schedule job ${job.tag}:`, error);
    }
  });
  
  logToFile(`Total jobs scheduled: ${activeJobs.size} of ${jobs.length} attempted`);
  
  // List all scheduled jobs
  logToFile('Currently scheduled jobs:');
  let jobIndex = 1;
  for (const [tag, job] of activeJobs.entries()) {
    logToFile(`  ${jobIndex++}. ${tag}`);
  }
  
  logToFile('=== Job Scheduling Complete ===');
}

// Function to check next execution times for all jobs
function checkAllNextExecutionTimes() {
  logToFile('=== Checking Next Execution Times ===');
  
  // Current time
  const now = new Date();
  const currentTimeFormatted = now.toLocaleString('en-US', { timeZone: TZ });
  logToFile(`Current time (${TZ}): ${currentTimeFormatted}`);
  
  // Process regular jobs
  const regularJobs = jobs.filter(job => !job.isNotification);
  
  logToFile(`\nRegular Jobs (${regularJobs.length}):`);
  regularJobs.forEach((job, index) => {
    try {
      const nextExecution = getNextExecution(job.cron);
      if (nextExecution) {
        logToFile(`${index + 1}. ${job.tag} (${job.cron})`);
        logToFile(`   Next execution: ${nextExecution.formatted}`);
        logToFile(`   Time until: ${nextExecution.formattedTimeLeft}`);
        logToFile(`   Message: ${job.text.substring(0, 50)}${job.text.length > 50 ? '...' : ''}`);
      } else {
        logToFile(`${index + 1}. ${job.tag} (${job.cron}) - Failed to calculate next execution`);
      }
    } catch (error) {
      logToFile(`${index + 1}. ${job.tag} - Error calculating next execution: ${error.message}`);
    }
  });
  
  // Process notification jobs
  const notificationJobs = jobs.filter(job => job.isNotification);
  
  logToFile(`\nNotification Jobs (${notificationJobs.length}):`);
  notificationJobs.forEach((job, index) => {
    try {
      const nextExecution = getNextExecution(job.cron);
      if (nextExecution) {
        logToFile(`${index + 1}. ${job.tag} (${job.cron})`);
        logToFile(`   Next execution: ${nextExecution.formatted}`);
        logToFile(`   Time until: ${nextExecution.formattedTimeLeft}`);
        logToFile(`   Message: ${job.text.substring(0, 50)}${job.text.length > 50 ? '...' : ''}`);
      } else {
        logToFile(`${index + 1}. ${job.tag} (${job.cron}) - Failed to calculate next execution`);
      }
    } catch (error) {
      logToFile(`${index + 1}. ${job.tag} - Error calculating next execution: ${error.message}`);
    }
  });
  
  logToFile('=== Next Execution Times Check Complete ===');
}

// Store temporary meetings
const scheduledMeetings = new Map();

// Add a unique identifier for meetings
let nextMeetingId = 1;

// Function to parse natural language dates using GPT
async function parseDate(dateString) {
  if (!openai) {
    logToFile('OpenAI not configured for date parsing');
    return null;
  }
  
  try {
    // Use GPT to parse the date string
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { 
          role: 'system', 
          content: `Parse the given date/time string and convert it to a precise ISO date time.
          Current time: ${new Date().toISOString()}
          Timezone: ${TZ}
          Return ONLY the ISO string without any explanation or additional text.`
        },
        { role: 'user', content: dateString }
      ],
      temperature: 0.1,
      max_tokens: 100
    });
    
    // Extract the completion
    const completion = response.choices[0]?.message?.content.trim();
    if (!completion) {
      return null;
    }
    
    // Try to parse the date
    const date = new Date(completion);
    if (isNaN(date.getTime())) {
      // Fallback: try to extract ISO date with regex
      const isoMatch = completion.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})/);
      if (isoMatch) {
        return new Date(isoMatch[0]);
      }
      return null;
    }
    
    return date;
  } catch (error) {
    logToFile(`Error parsing date with GPT: ${error.message}`);
    return null;
  }
}

// Manual date parser fallback
function manualDateParse(dateString) {
  // Try to handle common formats
  const now = new Date();
  const lowerInput = dateString.toLowerCase();
  
  // Handle relative times like "30m" or "2h"
  const minutesMatch = lowerInput.match(/^(\d+)m$/);
  if (minutesMatch) {
    const minutes = parseInt(minutesMatch[1]);
    const date = new Date(now.getTime() + minutes * 60000);
    return date;
  }
  
  const hoursMatch = lowerInput.match(/^(\d+)h$/);
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1]);
    const date = new Date(now.getTime() + hours * 3600000);
    return date;
  }
  
  // Handle "tomorrow at X"
  if (lowerInput.includes('tomorrow')) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Extract time if available
    const timeMatch = lowerInput.match(/(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?/);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
      const ampm = timeMatch[3];
      
      // Handle AM/PM
      if (ampm === 'pm' && hours < 12) {
        hours += 12;
      } else if (ampm === 'am' && hours === 12) {
        hours = 0;
      }
      
      tomorrow.setHours(hours, minutes, 0, 0);
    } else {
      // Default to 9 AM if no time specified
      tomorrow.setHours(9, 0, 0, 0);
    }
    
    return tomorrow;
  }
  
  // Handle "today at X"
  if (lowerInput.includes('today')) {
    const today = new Date(now);
    
    // Extract time if available
    const timeMatch = lowerInput.match(/(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?/);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
      const ampm = timeMatch[3];
      
      // Handle AM/PM
      if (ampm === 'pm' && hours < 12) {
        hours += 12;
      } else if (ampm === 'am' && hours === 12) {
        hours = 0;
      }
      
      today.setHours(hours, minutes, 0, 0);
    } else {
      // Default to current time + 1 hour if no time specified
      today.setHours(today.getHours() + 1, 0, 0, 0);
    }
    
    return today;
  }
  
  // Try to parse with Date constructor as a last resort
  const date = new Date(dateString);
  if (!isNaN(date.getTime())) {
    return date;
  }
  
  return null;
}

// Helper function to create a cron expression from a Date object
function createCronFromDate(date) {
  const minutes = date.getMinutes();
  const hours = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-indexed
  const dayOfWeek = date.getDay();
  
  return `${minutes} ${hours} ${dayOfMonth} ${month} ${dayOfWeek}`;
}

// Function to schedule a meeting
function scheduleMeeting(meetingId, channelId, date, mentionedUsers, title, description) {
  // Create a cron expression for the meeting time
  const meetingCron = createCronFromDate(date);
  
  // Create a date for 5 minutes before
  const reminderDate = new Date(date.getTime() - 5 * 60000);
  const reminderCron = createCronFromDate(reminderDate);
  
  // Format date for display
  const formattedDate = date.toLocaleString('en-US', { 
    timeZone: TZ,
    weekday: 'short',
    month: 'short', 
    day: 'numeric',
    hour: '2-digit', 
    minute: '2-digit'
  });
  
  // Create user mentions string
  const mentionsString = mentionedUsers.map(userId => `<@${userId}>`).join(' ');
  
  // Create meeting message
  const meetingMessage = `🗓️ **${title}** - Meeting time!\n${description ? description + '\n' : ''}${mentionsString}`;
  
  // Create reminder message
  const reminderMessage = `🔔 Reminder: **${title}** starts in 5 minutes at ${formattedDate}\n${mentionsString}`;
  
  // Store the meeting in memory
  scheduledMeetings.set(meetingId, {
    title,
    description,
    date,
    channelId,
    mentionedUsers,
    meetingJob: null,
    reminderJob: null
  });
  
  logToFile(`Scheduling meeting "${title}" for ${formattedDate} with ${mentionedUsers.length} users`);
  
  // Schedule the meeting job
  const meetingJob = cron.schedule(meetingCron, () => {
    // Send the meeting message
    const channel = client.channels.cache.get(channelId);
    if (channel) {
      channel.send(meetingMessage)
        .then(() => logToFile(`Sent meeting message for "${title}"`))
        .catch(err => logToFile(`Error sending meeting message: ${err.message}`));
      
      // Remove the meeting from memory after it's done
      scheduledMeetings.delete(meetingId);
    }
  }, { timezone: TZ, scheduled: true });
  
  // Schedule the reminder job
  const reminderJob = cron.schedule(reminderCron, () => {
    // Send the reminder message
    const channel = client.channels.cache.get(channelId);
    if (channel) {
      channel.send(reminderMessage)
        .then(() => logToFile(`Sent reminder message for "${title}"`))
        .catch(err => logToFile(`Error sending reminder message: ${err.message}`));
    }
  }, { timezone: TZ, scheduled: true });
  
  // Store the jobs in memory
  const meeting = scheduledMeetings.get(meetingId);
  meeting.meetingJob = meetingJob;
  meeting.reminderJob = reminderJob;
  
  return { meetingCron, reminderCron, formattedDate };
}
// Discord Bot for Insanity
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder } = require('discord.js');
const { OpenAI } = require('openai');
const moment = require('moment-timezone');
const { Client: NotionClient } = require('@notionhq/client');
const cron = require('node-cron');
const fs = require('fs'); // Re-add fs module
const path = require('path');
const { logToFile, frameioErrorMessage, axiosErrorMessage } = require('./log_utils');
const { addCreds, readJsonFile, writeJsonFile } = require('./utils');
const { loadTasks, saveTasks, addTask } = require('./tasks');
const points = require('./points');
const rewards = require('./rewards.json');
const axios = require('axios');
const express = require('express');
const cors = require('cors');
const app = express();
const { commands } = require('./commands');
const { initEmailForwarder } = require('./email_forwarder');
const GmailPoller = require('./email_poller');
const { initDatabase, logMessageToDB, importBackups } = require('./message_db');

// File to track notifications for stale VA Review projects
const STALE_VA_REVIEW_PATH = path.join(__dirname, 'stale-va-review.json');
let staleVaNotifications = readJsonFile(STALE_VA_REVIEW_PATH, {});

// Simple helper for rate-limited GET requests with retries
async function axiosGetWithRetry(url, headers, retries = 3, backoff = 1000) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await axios.get(url, { headers });
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < retries - 1) {
        const wait = backoff * (attempt + 1);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// Check for projects stuck in VA Review without updates
async function checkStaleVaReview() {
  if (!notion || !DB) {
    logToFile('checkStaleVaReview skipped: Notion not configured');
    return { success: false, error: 'Notion not configured' };
  }

  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const response = await notion.databases.query({
      database_id: DB,
      filter: {
        and: [
          { property: 'Status', status: { equals: 'VA Review' } },
          { timestamp: 'last_edited_time', last_edited_time: { on_or_before: cutoff } }
        ]
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
      page_size: 50
    });

    let notified = 0;

    for (const page of response.results) {
      const pageId = page.id;
      const lastNotified = staleVaNotifications[pageId];
      const now = new Date();
      if (lastNotified && (now - new Date(lastNotified)) < 24 * 60 * 60 * 1000) {
        continue; // already notified within 24h
      }

      // Get project title
      const titleProp = Object.values(page.properties).find(p => p.type === 'title');
      const title = titleProp?.title?.[0]?.plain_text || 'Untitled';

      // Determine discord channel from property or code
      let channelId = null;
      const dcProp = page.properties['Discord Channel'];
      if (dcProp?.url) {
        const m = dcProp.url.match(/channels\/\d+\/(\d+)/);
        if (m) channelId = m[1];
      } else if (dcProp?.rich_text?.length) {
        const text = dcProp.rich_text.map(t => t.plain_text).join('');
        const m = text.match(/(\d{17,})/);
        if (m) channelId = m[1];
      }
      if (!channelId) {
        const codeMatch = title.match(/(CL|IB|BC)\d{2}/i);
        const code = codeMatch ? codeMatch[0].toLowerCase() : null;
        if (code) {
          const ch = [...client.channels.cache.values()].find(c => c.type === 0 && c.name.includes(code));
          if (ch) channelId = ch.id;
        }
      }

      // Find assigned Discord users
      const ownerProp = page.properties['Project Owner'];
      let ownerNames = [];
      if (ownerProp?.people?.length) ownerNames = ownerProp.people.map(p => p.name);
      else if (ownerProp?.select?.name) ownerNames = [ownerProp.select.name];

      const ownerIds = ownerNames.map(name => {
        const staff = STAFF_AVAILABILITY.find(s =>
          (s.notionProjectOwnerName && s.notionProjectOwnerName.toLowerCase() === name.toLowerCase()) ||
          (s.notionTaskAssigneeName && s.notionTaskAssigneeName.toLowerCase() === name.toLowerCase())
        );
        return staff?.discordUserId;
      }).filter(Boolean);

      if (ownerIds.length === 0) continue;

      const mention = ownerIds.map(id => `<@${id}>`).join(' ');
      const message = `${mention} project **${title}** has been in **VA Review** for over 48 hours without updates.`;

      const targetChannel = client.channels.cache.get(channelId || SCHEDULE_CHANNEL_ID);
      if (targetChannel) {
        await targetChannel.send(message);
        staleVaNotifications[pageId] = now.toISOString();
        notified++;
      }
    }

    if (notified > 0) {
      writeJsonFile(STALE_VA_REVIEW_PATH, staleVaNotifications);
    }

    return { success: true, notified };
  } catch (err) {
    logToFile(`❌ Error in checkStaleVaReview: ${err.message}`);
    return { success: false, error: err.message };
  }
}


// Import knowledge assistant
const { handleAskCommand } = require('./knowledge-assistant');

// Configure OpenAI client
let openai = null;
try {
  console.log('Attempting to initialize OpenAI client...');
  if (process.env.OPENAI_API_KEY) {
    console.log('OPENAI_API_KEY found in environment variables');
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    console.log('OpenAI client initialized successfully');
    logToFile('OpenAI client initialized successfully');
  } else {
    console.log('⚠️ OPENAI_API_KEY not found in environment variables');
    console.log('Environment variables available:', Object.keys(process.env).join(', '));
    logToFile('OPENAI_API_KEY not found in environment, GPT task extraction will not be available');
  }
} catch (error) {
  console.log(`❌ Error initializing OpenAI client: ${error.message}`);
  logToFile(`Error initializing OpenAI client: ${error.message}`);
}

// Initialize simple message database
initDatabase();
const imported = importBackups();
if (imported > 0) {
  console.log(`Imported ${imported} messages from backups`);
}

// Style guardrail for the /create command
const RED_MONOLITH_STYLE = `### RED-MONOLITH — Universal Style Guardrail

GLOBAL PALETTE
- Monochrome reds only: #9B0000 → #FF2020 + pure black.
- Absolutely no other hues, tints, overlays, or highlights.

SURFACE & DETAIL LEVEL
3D-rendered digital scene in red monochrome. Wide-angle camera view. Stylized lighting with deep shadows and red highlights. Characters and environment look like clay or mannequin models with no textures but still detailed an accurate to real life humans. Environment resembles a night simulation or surveillance footage. Harsh red lighting casts strong silhouettes. 3D viewport aesthetic

EYES
- Solid red orbs with a faint inner glow (halo ≤ pupil diameter). No iris or whites.

CAMERA & FRAMING
- Default canvas 16 : 9.
- Encourage dramatic low- or high-angle shots; mild fisheye ≈ 12 mm when wide.

LIGHTING
- Single, strong red key light from camera-left (~30 ° elevation).
- Pitch-black shadows; smooth vignette to black at frame edges.

ENVIRONMENTS & PROPS
- Sparse, noir ambience; empty negative space is OK.

CLOTHING & ACCESSORIES
- All garments inherit the same material and palette rules.

HOW TO PROCESS A USER PROMPT
1. Keep their scene concept (characters, pose, environment, action).
2. Translate every element into the RED-MONOLITH vocabulary above—no deviations.
3. Output a single image that obeys all global rules, merging their description with these constraints.
4. If any part of the user prompt conflicts with these rules, adjust it to comply rather than refusing; mention the adjustment only if necessary.`;

// Setup timezone
const TZ = process.env.TIMEZONE || 'Europe/Berlin';

// Import availability module
const { STAFF_AVAILABILITY, isStaffActive, getTimeLeftInShift, createTimeProgressBar, formatWorkingHours, getStaffWorkloadDetails, getAIAvailabilityAssessment } = require('./availability');

// Define timezone for all operations
// const TZ = 'Europe/Berlin'; // Removed duplicate TZ declaration

// Map of active jobs
const activeJobs = new Map();

// Track the last image response ID for each user to allow follow-up edits
const lastImageResponses = new Map();
// Map bot message ID -> response ID for image generation, used for reply-based edits
const imageResponseMap = new Map();

// Schedule notification channel ID
const SCHEDULE_CHANNEL_ID = '1364301344508477541'; // Daily Work Schedule channel
const SCHEDULE_ROLE_ID = '1364657163598823474'; // Role ID to notify for scheduled meetings

// Daily message backup channel ID
const MESSAGE_BACKUP_CHANNEL_ID = '1296549507357741086'; // Channel to backup messages from

// Team mention role ID
const TEAM_ROLE_ID = '1364657163598823474';
// To-do list channel ID
const TODO_CHANNEL_ID = process.env.TODO_CHANNEL_ID;
// Email forwarding channel ID
const EMAIL_CHANNEL_ID = process.env.EMAIL_CHANNEL_ID;
const ENABLE_GMAIL_POLLER = process.env.ENABLE_GMAIL_POLLER === 'true';
const GMAIL_CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || path.join(process.cwd(), 'credentials.json');
const GMAIL_TOKEN_PATH = process.env.GMAIL_TOKEN_PATH || path.join(process.cwd(), 'token.json');
const GMAIL_CREDENTIALS_JSON = process.env.GMAIL_CREDENTIALS_JSON ? JSON.parse(process.env.GMAIL_CREDENTIALS_JSON) : null;
const GMAIL_TOKEN_JSON = process.env.GMAIL_TOKEN_JSON ? JSON.parse(process.env.GMAIL_TOKEN_JSON) : null;
const GMAIL_POLL_INTERVAL = parseInt(process.env.GMAIL_POLL_INTERVAL, 10) || 5;

// Store jobs in memory, each with a tag, cron expression, text, and whether to send a notification 5 min before
let jobs = [
  { tag: 'Social Fika', cron: '0 9 * * 1-5', text: `☕ <@&${TEAM_ROLE_ID}> **Social Fika** - Casual check-in + daily sync (9:00-9:20).`, notify: true },
  { tag: 'Deep Work AM', cron: '20 9 * * 1-5', text: `🧠 <@&${TEAM_ROLE_ID}> **Deep Work** starts now — focus mode ON (9:20-11:00).` },
  { tag: 'Fika Break', cron: '0 11 * * 1-5', text: `🍪 <@&${TEAM_ROLE_ID}> **Fika Break** - Short break time! (11:00-11:20)`, notify: true },
  { tag: 'Deep Work Continue', cron: '20 11 * * 1-5', text: `🧠 <@&${TEAM_ROLE_ID}> **Deep Work** continues — back to focused mode (11:20-13:00).` },
  { tag: 'Lunch Break', cron: '0 13 * * 1-5', text: `🍽 <@&${TEAM_ROLE_ID}> **Lunch break** – enjoy! Back at 13:45.`, notify: true },
  { tag: 'Planning Huddle', cron: '45 13 * * 1-5', text: `📋 <@&${TEAM_ROLE_ID}> **Planning Huddle** - Quick team sync (13:45-14:00).`, notify: true },
  { tag: 'Deep Work PM', cron: '0 14 * * 1-5', text: `🧠 <@&${TEAM_ROLE_ID}> **Deep Work PM** - Project execution and reviews (14:00-17:00).` },
  { tag: 'Wrap-Up Meeting', cron: '0 17 * * 1-5', text: `👋 <@&${TEAM_ROLE_ID}> **Wrap-Up Meeting** - Daily summary + vibes check for the day (17:00-17:30).`, notify: true },
  { tag: 'Daily Message Backup', cron: '0 11 * * *', text: '', backupMessages: true }, // New job to backup messages
  { tag: 'Morning Task Extraction', cron: '5 11 * * 1-5', text: '', extractTasks: true }, // Automatically extract tasks
  { tag: 'End-of-Day Task Check', cron: '0 20 * * 1-5', text: '', updateTasks: true }, // New job to check completed tasks
  { tag: 'VA Review Stale Check', cron: '0 9 * * *', text: '', checkVaReview: true }
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
const NOTION_WORKSPACE = process.env.NOTION_WORKSPACE;
const NOTION_TASKS_URL = process.env.NOTION_TASKS_URL ||
  (DB ? `https://www.notion.so/${NOTION_WORKSPACE ? `${NOTION_WORKSPACE}/` : ''}${DB.replace(/-/g, '')}` : null);
const CHANGELOG_DB = process.env.NOTION_CHANGELOG_DB_ID; // No hardcoded fallback - rely on environment variable
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const RUNWAY_MODEL = process.env.RUNWAY_MODEL;
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
console.log(`- NOTION_CHANGELOG_DB_ID: ${CHANGELOG_DB ? `✅ Set (${CHANGELOG_DB.substring(0, 6)}...)` : '❌ Missing'}`);
console.log(`- NOTION_TASKS_URL: ${NOTION_TASKS_URL ? '✅ Set' : '❌ Missing (will use default)'}`);
console.log(`- OPENAI_API_KEY: ${OPENAI_API_KEY ? '✅ Set' : '❌ Missing'}`);
console.log(`- RUNWAY_MODEL: ${RUNWAY_MODEL ? '✅ Set' : '❌ Missing'}`);

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
    console.log(`  - Using MAIN database ID: ${DB.substring(0, 8)}...`);
    console.log(`  - Using CHANGELOG database ID: ${CHANGELOG_DB.substring(0, 8)}...`);
    
    // Verify databases are different
    if (DB === CHANGELOG_DB) {
      console.error('❌ ERROR: Main database and changelog database have the same ID!');
      logToFile('❌ CRITICAL ERROR: Main database and changelog database have the same ID!');
    }
    
    // Store the database ID in global scope for access in functions
    global.NOTION_DATABASE_ID = DB;
    global.NOTION_CHANGELOG_DB_ID = CHANGELOG_DB;
  } else {
    if (!NOTION_KEY) console.warn('⚠️ NOTION_KEY not provided. Notion features will be disabled.');
    if (!DB) console.warn('⚠️ NOTION_DATABASE_ID not provided. Notion features will be disabled.');
  }
} catch (error) {
  console.warn('⚠️ Failed to initialize Notion client: ' + error.message + '. Notion features will be disabled.');
}

// Note: OpenAI client is already initialized at the top of the file
// let openai = null; (removed duplicate initialization)

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
    
    // IMPORTANT: ONLY use the main database ID here, never the changelog database
    // Get database ID from environment variable or global variable - ensure it's defined
    const databaseId = process.env.NOTION_DB_ID || process.env.NOTION_DATABASE_ID || DB;
    
    // Explicitly avoid using the changelog database
    if (databaseId === CHANGELOG_DB) {
      logToFile('ERROR: Attempted to search for projects in the changelog database instead of the main database!');
      console.error('❌ ERROR: Using changelog database instead of main project database.');
      return null;
    }
    
    logToFile(`Finding project "${query}" using MAIN database ID: ${databaseId}`);
    
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
client.once('ready', async () => {
  console.log('Bot is ready!');
  logToFile('Bot started successfully');
  
  // Remove standalone extract-tasks command registration and rely on the standard command registration
  // through the auto-register-commands.js module which will now include our command from commands.js
  
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
    const { registerCommandsOnStartup, registerCommandsToGuild } = require('./auto-register-commands');
    registerCommandsOnStartup(client, TOKEN)
      .then(() => console.log('Commands registered successfully'))
      .catch(error => {
        console.error('Error registering commands:', error);
        logToFile(`Error registering commands: ${error.message}`);
      });

    // Register specific commands to BODYCAM server
    const BODYCAM_SERVER_ID = '1290489132522672182';
    const CATEGORIES_TO_INCLUDE = ['basic', 'notion', 'utility'];
    const INSANITY_SERVER_ID = '1275557298307203123';
    const INSANITY_CATEGORIES = ['utility'];
    const FILES_SERVER_ID = '626755121501437957';
    const CREDIT_COMMANDS = ['creds'];
    
    // Check if the BODYCAM server exists in the bot's guilds
    const bodycamGuild = client.guilds.cache.get(BODYCAM_SERVER_ID);
    if (bodycamGuild) {
      logToFile(`Found BODYCAM server: ${bodycamGuild.name} (${bodycamGuild.id})`);

      // Register specific command categories to BODYCAM server
      registerCommandsToGuild(client, TOKEN, BODYCAM_SERVER_ID, CATEGORIES_TO_INCLUDE)
        .then(success => {
          if (success) {
            logToFile(`✅ Successfully registered specific commands to BODYCAM server`);
          } else {
            logToFile(`❌ Failed to register specific commands to BODYCAM server`);
          }
        })
        .catch(error => {
          logToFile(`Error registering specific commands to BODYCAM server: ${error.message}`);
        });
    } else {
      logToFile(`⚠️ BODYCAM server with ID ${BODYCAM_SERVER_ID} not found in bot's guilds`);
    }

    // Register utility commands to Dr Insanity server
    const insanityGuild = client.guilds.cache.get(INSANITY_SERVER_ID);
    if (insanityGuild) {
      logToFile(`Found DR INSANITY server: ${insanityGuild.name} (${insanityGuild.id})`);
      registerCommandsToGuild(client, TOKEN, INSANITY_SERVER_ID, INSANITY_CATEGORIES)
        .then(success => {
          if (success) {
            logToFile(`✅ Successfully registered utility commands to DR INSANITY server`);
          } else {
            logToFile(`❌ Failed to register utility commands to DR INSANITY server`);
          }
        })
        .catch(error => {
          logToFile(`Error registering utility commands to DR INSANITY server: ${error.message}`);
        });
    } else {
      logToFile(`⚠️ DR INSANITY server with ID ${INSANITY_SERVER_ID} not found in bot's guilds`);
    }

    // Register credit commands to FILES server
    const filesGuild = client.guilds.cache.get(FILES_SERVER_ID);
    if (filesGuild) {
      logToFile(`Found FILES server: ${filesGuild.name} (${filesGuild.id})`);
      registerCommandsToGuild(client, TOKEN, FILES_SERVER_ID, CREDIT_COMMANDS)
        .then(success => {
          if (success) {
            logToFile(`✅ Successfully registered Creds commands to FILES server`);
          } else {
            logToFile(`❌ Failed to register Creds commands to FILES server`);
          }
        })
        .catch(error => {
          logToFile(`Error registering Creds commands to FILES server: ${error.message}`);
        });
    } else {
      logToFile(`⚠️ FILES server with ID ${FILES_SERVER_ID} not found in bot's guilds`);
    }
  } catch (error) {
    console.error('Error registering commands:', error);
    logToFile(`Error registering commands: ${error.message}`);
  }
  
  // Schedule all jobs
  scheduleAllJobs();
  
  // Check next execution times
  checkAllNextExecutionTimes();

  // Start Gmail polling if enabled
  if (ENABLE_GMAIL_POLLER && EMAIL_CHANNEL_ID) {
    try {
      const emailPoller = new GmailPoller(
        client,
        EMAIL_CHANNEL_ID,
        GMAIL_CREDENTIALS_PATH,
        GMAIL_TOKEN_PATH,
        GMAIL_CREDENTIALS_JSON,
        GMAIL_TOKEN_JSON
      );
      await emailPoller.initialize();
      emailPoller.startPolling(GMAIL_POLL_INTERVAL);
    } catch (error) {
      logToFile(`Failed to start Gmail polling: ${error.message}`);
    }
  }
  
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
  // Handle button interactions
  if (interaction.isButton()) {
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
      try {
        await interaction.reply({ 
          content: '❌ Error refreshing schedule timers. Please try again.',
          ephemeral: true 
        });
      } catch (replyError) {
        logToFile(`Failed to send error reply: ${replyError.message}`);
      }
    }
    return;
  }

  // Handle command interactions
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;
  
  // Add global error handling for all command interactions
  try {
    let hasResponded = false;
    
    // Handle the /extract-tasks command
    if (commandName === 'extract-tasks') {
      try {
        // Always use ephemeral replies for this command
        await interaction.deferReply({ ephemeral: true });
        
        // Run the task extraction
        await interaction.editReply('⏳ Extracting tasks from morning messages...');
        
        const result = await extractTasksFromMorningMessages();
        
        if (!result.success) {
          return interaction.editReply(`❌ Error extracting tasks: ${result.error}`);
        }
        
        if (result.messageCount === 0) {
          return interaction.editReply('No messages found from this morning (since 8 AM).');
        }
        
        // Create embed for response
        const embed = new EmbedBuilder()
          .setTitle('Task Extraction Complete')
          .setColor(0x00AA00)
          .setDescription(`I've extracted tasks from this morning's messages and created individual Notion task pages with proper assignees.`)
          .addFields(
            { name: 'Messages Processed', value: `${result.messageCount}`, inline: true },
            { name: 'Tasks Extracted', value: `${result.taskCount}`, inline: true },
            { name: 'Task Pages Created', value: `${result.pagesCreated}`, inline: true },
            { name: 'Team Members', value: `${result.authors}`, inline: true }
          )
          .setTimestamp();

        if (NOTION_TASKS_URL) {
          embed.addFields({ name: 'Notion Database', value: `[View Tasks](${NOTION_TASKS_URL})` });
        }
        
        // Send the response
        await interaction.editReply({ 
          content: '✅ Task extraction completed successfully!', 
          embeds: [embed] 
        });
        
      } catch (error) {
        logToFile(`Error in /extract-tasks command: ${error.message}`);
        await interaction.editReply(`❌ Error extracting tasks: ${error.message}`);
      }
    }
    
    // All other commands continue to be handled by the existing handlers
    // (The code below is merged from the existing handler at line ~984)
    
    // Handle the /where command
    if (commandName === 'where') {
      try {
        // Check if ephemeral flag is set
        const ephemeral = true;
        await interaction.deferReply({ ephemeral });
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
        if (statusPropertyName) {
          // Check for status type properties first
          if (properties[statusPropertyName]?.status?.name) {
            status = properties[statusPropertyName].status.name;
            logToFile(`Found status (status type) using property name: "${statusPropertyName}"`);
          } 
          // Then try select type
          else if (properties[statusPropertyName]?.select?.name) {
            status = properties[statusPropertyName].select.name;
            logToFile(`Found status (select type) using property name: "${statusPropertyName}"`);
          } else {
            logToFile(`Status property found but couldn't extract value from "${statusPropertyName}"`);
          }
        } else {
          // Fallback to direct property checks
          if (properties.Status?.status?.name) {
            status = properties.Status.status.name;
          } else if (properties.Status?.select?.name) {
            status = properties.Status.select.name;
          } else if (properties.status?.status?.name) {
            status = properties.status.status.name;
          } else if (properties.status?.select?.name) {
            status = properties.status.select.name;
          } else {
            // Log all property names for debugging
            logToFile(`Available properties for ${code}: ${Object.keys(properties).join(', ')}`);
          }
        }
        
        const dueDate = properties["Upload Date"]?.date?.start || 'No Due Date';
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
    
    // Handle the /deadline command
    else if (commandName === 'deadline') {
      try {
        // Check if ephemeral flag is set
        const ephemeral = interaction.options.getBoolean('ephemeral') || false;
        const showAll = interaction.options.getBoolean('all') || false;
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        
        // Check if Notion is configured
        if (!notion) {
          await interaction.editReply('❌ Notion integration is not configured. Please ask an administrator to set up the Notion API token and database ID.');
          return;
        }
        
        // Get the guild (server) to determine which project series to show if showing all
        const guild = interaction.guild;
        const guildName = guild?.name?.toLowerCase() || '';
        
        let projectCode = null;
        let projectSeries = null;
        
        // If showAll is false, get the project code from the channel name
        if (!showAll) {
          const channel = interaction.channel;
          if (!channel) {
            await interaction.editReply('❌ This command can only be used in a text channel.');
            return;
          }
          
          // Check if the channel name contains a project code
          const channelName = channel.name.toLowerCase();
          const codeMatch = channelName.match(/(ib|cl|bc)\d{2}/i);
          
          if (!codeMatch) {
            await interaction.editReply('❌ This channel does not appear to be linked to a project. Channel name should contain a project code like IB23, CL45, etc. Use `/deadline all` to see all deadlines.');
            return;
          }
          
          projectCode = codeMatch[0].toUpperCase();
          logToFile(`Fetching deadline for specific project: ${projectCode}`);
        } else {
          // For "all" mode, determine which series to show based on the server name
          if (guildName.includes('bodycam')) {
            projectSeries = 'BC';
          } else if (guildName.includes('insanity')) {
            // For Dr. Insanity server, show both CL and IB
            projectSeries = null; // We'll handle showing both series in the code below
          } else {
            // Default to showing all projects
            projectSeries = null;
          }
          
          logToFile(`Fetching all deadlines for series: ${projectSeries || 'ALL'} in guild: ${guildName}`);
        }
        
        let result;
        
        if (projectCode) {
          // Fetch a single project by code
          result = await fetchProjectDeadlines(null, projectCode);
        } else if (projectSeries) {
          // Fetch all projects of a specific series
          result = await fetchProjectDeadlines(projectSeries);
        } else if (guildName.includes('insanity')) {
          // Special case for Dr. Insanity server - fetch both CL and IB
          const clResult = await fetchProjectDeadlines('CL');
          const ibResult = await fetchProjectDeadlines('IB');
          
          if (!clResult.success || !ibResult.success) {
            await interaction.editReply(`❌ Error fetching deadlines: ${clResult.error || ibResult.error}`);
            return;
          }
          
          // Combine the results
          result = { 
            success: true, 
            projects: [...(clResult.projects || []), ...(ibResult.projects || [])]
          };
          
          // Re-sort combined projects
          result.projects.sort((a, b) => {
            if (a.mainDeadline && b.mainDeadline) {
              return new Date(a.mainDeadline) - new Date(b.mainDeadline);
            }
            if (a.mainDeadline) return -1;
            if (b.mainDeadline) return 1;
            return a.code.localeCompare(b.code);
          });
        } else {
          // Fetch all projects (default)
          result = await fetchProjectDeadlines();
        }
        
        if (!result.success) {
          await interaction.editReply(`❌ Error fetching deadlines: ${result.error}`);
          return;
        }
        
        const projects = result.projects;
        
        if (projects.length === 0) {
          await interaction.editReply('No projects found with deadline information.');
          return;
        }
        
        // Create the embed
        const embed = new EmbedBuilder()
          .setColor(0x0099FF)
          .setTimestamp();
        
        // Set the title and description based on whether we're showing a single project or all
        if (projectCode) {
          embed.setTitle(`📅 Deadline for ${projectCode}`);
          embed.setDescription(`Here are the deadline details for ${projectCode}:`);
        } else {
          embed.setTitle(`📅 Project Deadlines${projectSeries ? ` - ${projectSeries} Series` : ''}`);
          embed.setDescription(`Here are the upcoming deadlines for ${projectSeries ? `${projectSeries} series` : 'all'} projects:`);
        }
        
        // Choose how to display the data based on whether we're showing one project or many
        if (projectCode && projects.length === 1) {
          // Detailed view for a single project
          const project = projects[0];
          
          // Add direct fields for the project
          embed.addFields({ name: 'Project', value: project.name });
          embed.addFields({ name: 'Status', value: project.status || 'Not set' });
          embed.addFields({ name: 'Main Deadline', value: project.formattedMainDeadline || 'Not set', inline: true });
          embed.addFields({ name: 'Current Stage Deadline', value: project.formattedStageDeadline || 'Not set', inline: true });
          
          // Add countdown if a deadline exists
          if (project.mainDeadline) {
            const now = new Date();
            const deadline = new Date(project.mainDeadline);
            const daysRemaining = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));
            
            const countdownText = daysRemaining > 0 
              ? `⏰ **${daysRemaining} day${daysRemaining !== 1 ? 's' : ''} remaining**`
              : daysRemaining === 0
                ? `⚠️ **Due today!**`
                : `❌ **Overdue by ${Math.abs(daysRemaining)} day${Math.abs(daysRemaining) !== 1 ? 's' : ''}**`;
            
            embed.addFields({ name: 'Countdown', value: countdownText });
          }
          
          // Add a button to open the Notion page
          const row = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setLabel('Open in Notion')
                .setStyle(ButtonStyle.Link)
                .setURL(project.notionUrl)
            );
          
          await interaction.editReply({ embeds: [embed], components: [row] });
        } else {
          // Summarized view for multiple projects
          // Group projects by their deadlines for a cleaner presentation
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          
          const overdue = [];
          const dueToday = [];
          const dueThisWeek = [];
          const dueNextWeek = [];
          const dueLater = [];
          const noDueDate = [];
          
          // Calculate the end of this week and next week
          const endOfThisWeek = new Date(today);
          endOfThisWeek.setDate(today.getDate() + (7 - today.getDay()));
          
          const endOfNextWeek = new Date(endOfThisWeek);
          endOfNextWeek.setDate(endOfThisWeek.getDate() + 7);
          
          // Categorize projects
          projects.forEach(project => {
            if (!project.mainDeadline) {
              noDueDate.push(project);
              return;
            }
            
            const deadlineDate = new Date(project.mainDeadline);
            deadlineDate.setHours(0, 0, 0, 0);
            
            if (deadlineDate < today) {
              overdue.push(project);
            } else if (deadlineDate.getTime() === today.getTime()) {
              dueToday.push(project);
            } else if (deadlineDate <= endOfThisWeek) {
              dueThisWeek.push(project);
            } else if (deadlineDate <= endOfNextWeek) {
              dueNextWeek.push(project);
            } else {
              dueLater.push(project);
            }
          });
          
          // Create a formatter function for projects
          const formatProjectList = (projects) => {
            return projects.map(p => {
              let line = `**${p.code}** (${p.status}): ${p.formattedMainDeadline}`;
              
              // Add stage deadline if different from main deadline
              if (p.stageDeadline && p.stageDeadline !== p.mainDeadline) {
                line += ` • Stage: ${p.formattedStageDeadline}`;
              }
              
              return line;
            }).join('\n');
          };
          
          // Add all the deadline sections
          if (overdue.length > 0) {
            embed.addFields({ 
              name: '❌ OVERDUE', 
              value: formatProjectList(overdue)
            });
          }
          
          if (dueToday.length > 0) {
            embed.addFields({ 
              name: '⚠️ DUE TODAY', 
              value: formatProjectList(dueToday)
            });
          }
          
          if (dueThisWeek.length > 0) {
            embed.addFields({ 
              name: '⏳ DUE THIS WEEK', 
              value: formatProjectList(dueThisWeek)
            });
          }
          
          if (dueNextWeek.length > 0) {
            embed.addFields({ 
              name: '📅 DUE NEXT WEEK', 
              value: formatProjectList(dueNextWeek)
            });
          }
          
          if (dueLater.length > 0) {
            embed.addFields({ 
              name: '🗓️ FUTURE DEADLINES', 
              value: formatProjectList(dueLater)
            });
          }
          
          if (noDueDate.length > 0) {
            embed.addFields({ 
              name: '⚠️ NO DEADLINE SET', 
              value: formatProjectList(noDueDate)
            });
          }
          
          // Set footer with total count
          embed.setFooter({ 
            text: `Total: ${projects.length} projects • Use /deadline without 'all' in a project channel for details`
          });
          
          await interaction.editReply({ embeds: [embed] });
        }
      } catch (error) {
        logToFile(`Error in /deadline command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error displaying deadlines: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error displaying deadlines: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /availability command
    else if (commandName === 'availability') {
      try {
        const ephemeral = true; 
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        
        logToFile('[AvailabilityCommand] Command initiated.');
        const berlinTime = moment().tz('Europe/Berlin').format('dddd, MMMM D, YYYY HH:mm:ss');
        
        const embed = new EmbedBuilder()
          .setTitle('Team Availability & Workload')
          .setDescription(`Current time in Berlin: **${berlinTime}**\nStaff currently working are highlighted. Workload from Notion. AI assessment of availability.`)
          .setColor(0x00AAFF)
          .setTimestamp();
        
        const activeStaff = [];
        const inactiveStaff = [];
        
        logToFile(`[AvailabilityCommand] Starting to iterate through ${STAFF_AVAILABILITY.length} staff members.`);
        for (const staff of STAFF_AVAILABILITY) {
          // Log details for each staff member at the beginning of their processing
          logToFile(`[AvailabilityCommand] Processing staff member: ${staff.name} (Discord ID: ${staff.discordUserId}, Project Owner: ${staff.notionProjectOwnerName}, Task Assignee: ${staff.notionTaskAssigneeName})`);
          
          const isActive = isStaffActive(staff);
          logToFile(`[AvailabilityCommand] Staff ${staff.name} - isActive: ${isActive}`); // Log active status immediately
          
          const timeLeft = getTimeLeftInShift(staff);
          const workingHours = formatWorkingHours(staff);
          let workloadInfo = 'Notion data unavailable';
          let aiAssessment = 'N/A';

          if (staff.discordUserId && staff.discordUserId.startsWith('TODO')) {
            workloadInfo = 'Discord ID missing for Notion lookup.';
            logToFile(`[AvailabilityCommand] Staff ${staff.name}: Discord ID missing.`);
          } else if (staff.notionProjectOwnerName || staff.notionTaskAssigneeName) {
            try {
              logToFile(`[AvailabilityCommand] Staff ${staff.name}: Fetching workload details...`);
              const { projects, tasks } = await getStaffWorkloadDetails(staff);
              logToFile(`[AvailabilityCommand] Staff ${staff.name}: Workload details received. Projects: ${projects.length}, Tasks: ${tasks.length}`);
              
              let projectsString = 'No active projects.';
              if (projects.length > 0) {
                const caseNumbers = projects.map(p => {
                  const match = p.name.match(/(BC|CL|IB)\d{2}/i);
                  return match ? match[0].toUpperCase() : p.name;
                }).join(', ');
                projectsString = caseNumbers;
                if (projectsString.length > 100) projectsString = projectsString.substring(0, 97) + "...";
              }
              workloadInfo = `Projects: ${projectsString}\nTasks: ${tasks.length} active`;

              if (isActive) {
                if (projects.length > 0 || tasks.length > 0) {
                  logToFile(`[AvailabilityCommand] Staff ${staff.name}: Getting AI assessment...`);
                  aiAssessment = await getAIAvailabilityAssessment(staff.name, projects, tasks);
                  logToFile(`[AvailabilityCommand] Staff ${staff.name}: AI assessment received: ${aiAssessment}`);
                } else {
                  aiAssessment = 'Highly Available - No projects or tasks listed.';
                  logToFile(`[AvailabilityCommand] Staff ${staff.name}: AI assessment skipped (no projects/tasks).`);
                }
              } else {
                aiAssessment = 'N/A (Offline)';
              }

            } catch (e) {
              logToFile(`[AvailabilityCommand] Staff ${staff.name}: Error fetching workload/AI data: ${e.message}\n${e.stack}`);
              workloadInfo = 'Error fetching Notion/AI data.';
            }
          } else {
            workloadInfo = 'Notion names not configured.';
            logToFile(`[AvailabilityCommand] Staff ${staff.name}: Notion names not configured.`);
          }
          
          const staffInfo = {
            name: staff.name,
            isActive,
            timeLeft,
            workingHours,
            workload: workloadInfo,
            aiAssessment: aiAssessment, 
          };
          
          if (isActive) {
            activeStaff.push(staffInfo);
          } else {
            inactiveStaff.push(staffInfo);
          }
          logToFile(`[AvailabilityCommand] Staff ${staff.name}: Processing complete. Added to ${isActive ? 'active' : 'inactive'} list.`);
        }
        
        logToFile('[AvailabilityCommand] All staff processed. Building embed.');

        if (activeStaff.length > 0) {
          const activeStaffText = activeStaff.map(s => 
            `**${s.name}** (${s.timeLeft}) - ${s.workingHours}\n*Workload:* ${s.workload}\n${s.aiAssessment}` // Removed 'AI Eval: ' prefix
          ).join('\n\n');
          embed.addFields({ name: '🟢 Currently Working', value: activeStaffText.substring(0, 1020) });
        } else {
          embed.addFields({ name: '🟢 Currently Working', value: 'No team members are currently working.' });
        }
        
        if (inactiveStaff.length > 0) {
          const inactiveStaffText = inactiveStaff.map(s => 
            `${s.name} - ${s.workingHours}\n*Workload:* ${s.workload}\n${s.aiAssessment}` // Removed 'AI Eval: ' prefix
          ).join('\n\n');
          embed.addFields({ name: '⚪ Not Working', value: inactiveStaffText.substring(0, 1020) });
        }
        
        embed.setFooter({ text: 'All working hours converted to Europe/Berlin timezone' });
        
        logToFile('[AvailabilityCommand] Sending reply.');
        await interaction.editReply({ embeds: [embed] });
        logToFile('[AvailabilityCommand] Reply sent.');
        
      } catch (error) {
        logToFile(`Error in /availability command: ${error.message}\n${error.stack}`);
        console.error(`Error in /availability command:`, error); // Also log to console for immediate visibility
        if (hasResponded && !interaction.replied) { // Check if deferred and not yet replied
            try {
                await interaction.editReply({ content: `❌ Error displaying availability. Please check the bot logs.` });
            } catch (replyError) {
                logToFile(`[AvailabilityCommand] Failed to send error reply: ${replyError.message}`);
            }
        } else if (!interaction.replied && !interaction.deferred) { // Neither deferred nor replied
            try {
                await interaction.reply({ content: `❌ Error displaying availability. Please check the bot logs.`, ephemeral: true});
            } catch (replyError) {
                logToFile(`[AvailabilityCommand] Failed to send initial error reply: ${replyError.message}`);
            }
        }
      }
    }
    
    // Handle the /analyze command
    else if (commandName === 'analyze') {
      try {
        // Get command options with defaults
        const messageCount = interaction.options.getInteger('messages') || 100;
        const dryRun = interaction.options.getBoolean('dry_run') || false;
        const ephemeral = true;
        
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
              type: "status",
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
            propertiesToUpdate['Upload Date'] = {
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
        const ephemeral = interaction.options.getBoolean('ephemeral') || false;
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
        const ephemeral = true;
        
        await interaction.deferReply({ ephemeral });
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
   • Upload Date (Date): Primary upload/due date
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

Example Input: "Change status to Clip Selection and set the editor to Sarah and upload date to next Friday"
Example Output: {
  "Status": "Clip Selection",
  "Editor": "Sarah",
  "Upload Date": "2023-06-02"
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
        
        // Track status updates separately
        let hasStatusUpdate = false;
        let statusValue = null;
        
        // Convert extracted properties to Notion format
        const notionProperties = {};
        
        // Map properties to Notion format
        for (const [key, value] of Object.entries(properties)) {
          if (!value || value === '') continue;
          
          // Find the best matching property name in the page properties
          const bestMatch = findBestPropertyMatch(project.page.properties, key);
          const propertyKey = bestMatch || key;
          
          // Special handling for Status property
          if (key === 'Status') {
            // Don't add to notionProperties, we'll handle it separately
            logToFile(`Found Status property with value: ${value} - will update separately`);
            hasStatusUpdate = true;
            statusValue = value;
            continue;
          }
          
          // Handle different property types
          switch (key) {
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
              
            case 'Upload Date':
            case 'Date':
            case 'Date for current stage':
              const dateKey = propertyKey === 'Date' ? 'Upload Date' : propertyKey;
              notionProperties[dateKey] = { date: { start: value } };
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
            // First, handle regular properties
            if (Object.keys(notionProperties).length > 0) {
              logToFile(`Updating regular properties: ${JSON.stringify(notionProperties)}`);
              
              // Update the Notion page with non-status properties
              await notion.pages.update({
                page_id: project.page.id,
                properties: notionProperties
              });
              
              logToFile(`Successfully updated regular properties`);
            }
            
            // Then, handle Status property separately if present
            if (hasStatusUpdate && statusValue) {
              logToFile(`Updating Status separately to: "${statusValue}"`);
              
              const statusResult = await updateNotionStatus(project.page.id, statusValue);
              
              if (statusResult.success) {
                logToFile(`Successfully updated Status to "${statusValue}"`);
              } else {
                logToFile(`Failed to update Status: ${statusResult.error?.message || "Unknown error"}`);
                throw statusResult.error || new Error("Failed to update Status");
              }
            }
            
            // Get Notion URL for page
            const notionUrl = getNotionPageUrl(project.page.id);
            
            logToFile(`Notion updated for ${projectCode}`);
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
            try {
              // Use our helper function to update status
              const statusResult = await updateNotionStatus(project.page.id, value);
              
              if (!statusResult.success) {
                throw statusResult.error || new Error("Failed to update status");
              }
              
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
                content: `✅ Updated status to "${value}" for project ${projectCode}`,
                components: components.length > 0 ? components : undefined
              });
              
              // Also send a non-ephemeral message to channel for visibility
              await channel.send(
                `✅ <@${interaction.user.id}> set status to "${value}" for project ${projectCode}`
              );
              
              // Notify any relevant users of status change
              checkStatusAndNotify(projectCode, value, channel.id);
              
              // Return early to bypass the rest of the switch statement
              return;
            } catch (statusError) {
              // Log the exact error
              logToFile(`Error updating status: ${statusError.message}`);
              throw statusError;
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
              notionProperties['Upload Date'] = { date: { start: date.toISOString().split('T')[0] } };
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
            
          case 'storyboard':
            if (!value.startsWith('http')) {
              await interaction.editReply('❌ Storyboard value must be a valid URL starting with http:// or https://');
              return;
            }
            notionProperties['Storyboard'] = { url: value };
            break;
            
          case 'footage':
            if (value.startsWith('http')) {
              notionProperties['Footage'] = { url: value };
            } else {
              notionProperties['Footage'] = { rich_text: [{ text: { content: value } }] };
            }
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
          // Improved error logging with detailed message
          logToFile(`Error updating property in /set command: ${updateError.message}`);
          if (updateError.code) {
            logToFile(`Error code: ${updateError.code}`);
          }
          if (updateError.body) {
            logToFile(`Error body: ${updateError.body}`);
          }
          
          // Provide better error message to the user based on error type
          let errorMessage = `❌ Error updating property: ${updateError.message}`;
          
          if (updateError.message.includes('permission')) {
            errorMessage = `❌ Notion permission error: The bot doesn't have permission to update this property. Please make sure the Notion integration has been added to the database (via "Add connections" menu) and has "Update content" capabilities.`;
          } else if (updateError.message.includes('status is expected to be')) {
            errorMessage = `❌ Property type mismatch: This property has a different type than expected. Try using the /sync command instead which can handle different property types.`;
          }
          
          await interaction.editReply(errorMessage);
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
        const embed = new EmbedBuilder()
          .setTitle('Insanity Discord Bot Help')
          .setDescription('Here are the available commands:')
          .setColor(0x0099FF);

        for (const [category, cmds] of Object.entries(commands)) {
          const value = cmds
            .map(c => `/${c.name} - ${c.description}`)
            .join('\n');
          const name = category.charAt(0).toUpperCase() + category.slice(1);
          embed.addFields({ name, value });
        }

        embed
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
        const ephemeral = true;
        
        await interaction.deferReply({ ephemeral });
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
        const ephemeral = true;
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        
        // Check permissions
        const channel = interaction.channel;
        if (!channel) {
          await interaction.editReply('❌ This command can only be used in a text channel.');
          return;
        }
        
        // Check for required permissions
        const permissions = channel.permissionsFor(client.user);
        if (!permissions) {
          await interaction.editReply('❌ Cannot check channel permissions. Please make sure I have the "View Channel" permission.');
          return;
        }
        
        if (!permissions.has('SendMessages')) {
          await interaction.editReply('❌ I don\'t have permission to send messages in this channel. Please grant me the "Send Messages" permission.');
          return;
        }
        
        if (!permissions.has('ViewChannel')) {
          await interaction.editReply('❌ I don\'t have permission to view this channel. Please grant me the "View Channel" permission.');
          return;
        }
        
        // Extract user IDs from the users string
        const mentionedUserIds = [];
        
        if (usersString) {
          const userMatches = usersString.matchAll(/<@!?(\d+)>/g);
          for (const match of userMatches) {
            mentionedUserIds.push(match[1]);
          }
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
        const meetingId = Math.floor(Math.random() * 10000) + 1;
        
        // Format date for display
        const formattedDate = meetingDate.toLocaleString('en-US', { 
          timeZone: TZ,
          weekday: 'short',
          month: 'short', 
          day: 'numeric',
          hour: '2-digit', 
          minute: '2-digit'
        });
        
        // Create the user mentions string for the response
        const mentionsString = mentionedUserIds.map(userId => `<@${userId}>`).join(' ');
        
        // Create message for the meeting time
        const reminderMessage = `🔔 Reminder: **${title}** starts in 5 minutes!\n${description ? description + '\n' : ''}${mentionsString}`;
        const meetingMessage = `🗓️ **${title}** - It's meeting time!\n${description ? description + '\n' : ''}${mentionsString}`;
        
        // Schedule the meeting timestamp (Unix time in ms)
        const meetingTime = meetingDate.getTime();
        const reminderTime = meetingTime - (5 * 60 * 1000); // 5 min before
        
        // Schedule the reminder
        setTimeout(() => {
          channel.send(reminderMessage)
            .then(() => logToFile(`Sent reminder for meeting "${title}"`))
            .catch(err => logToFile(`Error sending reminder: ${err.message}`));
        }, reminderTime - now.getTime());
        
        // Schedule the meeting
        setTimeout(() => {
          channel.send(meetingMessage)
            .then(() => logToFile(`Sent meeting notification for "${title}"`))
            .catch(err => logToFile(`Error sending meeting notification: ${err.message}`));
        }, meetingTime - now.getTime());
        
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
        await channel.send(
          `🆕 <@${interaction.user.id}> scheduled a meeting **${title}** for ${formattedDate} with ${mentionsString}`
        );
        
        logToFile(`Meeting "${title}" scheduled for ${formattedDate} with ${mentionedUserIds.length} participants`);
        
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
        const ephemeral = true;
        
        await interaction.deferReply({ ephemeral });
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
          logToFile(`Searching for status changes in changelog database ${CHANGELOG_DB} for project ${targetProjectCode}`);
          
          const response = await notion.databases.query({
            database_id: CHANGELOG_DB,
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
    
    // Handle the /summary command
    else if (commandName === 'summary') {
      try {
        // Get command options
        const days = interaction.options.getInteger('days') || 7;
        const ephemeral = true;
        
        await interaction.deferReply({ ephemeral });
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
        
        // Fetch messages from the past X days
        const now = new Date();
        const pastDate = new Date(now);
        pastDate.setDate(pastDate.getDate() - days);
        
        logToFile(`Fetching messages for project ${projectCode} since ${pastDate.toISOString()}`);
        
        try {
          // Start with a small batch of messages
          let messages = await channel.messages.fetch({ limit: 100 });
          let allMessages = [...messages.values()];
          let oldestMessage = allMessages[allMessages.length - 1];
          
          // Keep fetching until we reach messages from 'days' ago or hit API limits
          while (oldestMessage && oldestMessage.createdAt > pastDate && allMessages.length < 500) {
            const nextBatch = await channel.messages.fetch({ 
              limit: 100,
              before: oldestMessage.id
            });
            
            if (nextBatch.size === 0) break;
            
            const nextMessages = [...nextBatch.values()];
            allMessages = [...allMessages, ...nextMessages];
            oldestMessage = nextMessages[nextMessages.length - 1];
            
            logToFile(`Fetched ${allMessages.length} messages so far, oldest from ${oldestMessage.createdAt.toISOString()}`);
          }
          
          // Filter messages by date
          const filteredMessages = allMessages.filter(msg => msg.createdAt > pastDate);
          
          logToFile(`Found ${filteredMessages.length} messages in the last ${days} days for project ${projectCode}`);
          
          // If no messages found in the specified timeframe
          if (filteredMessages.length === 0) {
            await interaction.editReply(`No messages found in the last ${days} days for project ${projectCode}.`);
            return;
          }
          
          // Prepare messages for analysis - sort chronologically
          const messageTexts = filteredMessages
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map(msg => `${msg.author.tag} (${msg.createdAt.toISOString()}): ${msg.content}`)
            .join('\n');
          
          // Create system prompt for GPT to summarize the conversation
          const systemPrompt = `
            You are a helpful assistant that summarizes Discord conversations.
            
            Your task is to create a concise summary of messages from a project's Discord channel.
            Focus on the following aspects:
            
            1. Key decisions made
            2. Important updates about the project status
            3. Action items or tasks assigned
            4. Questions that need answers
            5. Progress updates
            6. Timeline/schedule changes
            
            Format your response as a clear, organized summary with bullet points grouped into categories.
            Use headers to separate different topics.
            Keep your summary professional and concise, highlighting only the most relevant information.
          `;
          
          // Send to GPT-4 for processing
          logToFile(`Sending ${filteredMessages.length} messages to OpenAI for summarization`);
          
          const gptResponse = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: messageTexts }
            ],
            max_tokens: 1500
          });
          
          // Extract completion
          const summary = gptResponse.choices[0]?.message?.content;
          if (!summary) {
            await interaction.editReply('❌ Error: No summary received from OpenAI.');
            return;
          }
          
          logToFile(`Generated summary for project ${projectCode}`);
          
          // Create embed for response
          const embed = new EmbedBuilder()
            .setTitle(`📋 Summary for ${projectCode} - Last ${days} Days`)
            .setColor(0x00AAFF)
            .setDescription(summary.length > 4000 ? summary.substring(0, 4000) + '...' : summary)
            .setTimestamp();
          
          // Add footer with message count and timeframe
          embed.setFooter({ 
            text: `Based on ${filteredMessages.length} messages from the past ${days} days` 
          });
          
          // Create button to view project in Notion
          const notionUrl = getNotionPageUrl(project.page.id);
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
          
        } catch (fetchError) {
          logToFile(`Error fetching messages: ${fetchError.message}`);
          await interaction.editReply(`❌ Error fetching messages: ${fetchError.message}`);
          return;
        }
        
      } catch (error) {
        logToFile(`Error in /summary command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error generating summary: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error generating summary: ${error.message}`, ephemeral: true });
        }
      }
    }

    // Handle the /export command
    else if (commandName === 'export') {
      try {
        const format = interaction.options.getString('format');
        const includeHistory = interaction.options.getBoolean('include_history') || false;
        const ephemeral = true;

        await interaction.deferReply({ ephemeral });
        hasResponded = true;

        if (!notion) {
          await interaction.editReply('❌ Notion integration is not configured.');
          return;
        }

        const channel = interaction.channel;
        if (!channel) {
          await interaction.editReply('❌ This command can only be used in a text channel.');
          return;
        }

        const codeMatch = channel.name.toLowerCase().match(/(ib|cl|bc)\d{2}/i);
        if (!codeMatch) {
          await interaction.editReply('❌ This channel does not appear to be linked to a project.');
          return;
        }

        const projectCode = codeMatch[0].toUpperCase();
        const project = await findProjectByQuery(projectCode);
        if (!project) {
          await interaction.editReply(`❌ Could not find project with code "${projectCode}" in Notion database.`);
          return;
        }

        const props = project.page.properties;
        const data = {
          code: projectCode,
          name: project.name,
          status: props.Status?.status?.name || props.Status?.select?.name || 'Unknown',
          due_date: props['Upload Date']?.date?.start || 'Unknown',
          notion_url: getNotionPageUrl(project.page.id)
        };

        if (includeHistory) data.last_edited = project.page.last_edited_time;

        const filePath = exportProjectData(data, format);

        const dm = await interaction.user.createDM();
        await dm.send({ content: `Here is the ${format.toUpperCase()} export for ${projectCode}`, files: [new AttachmentBuilder(filePath)] });

        await interaction.editReply('✅ Export completed! Check your DMs.');
      } catch (error) {
        logToFile(`Error in /export command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error exporting project: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error exporting project: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /remind command
    else if (commandName === 'remind') {
      try {
        // Get command options
        const user = interaction.options.getUser('user');
        const message = interaction.options.getString('message');
        const time = interaction.options.getString('time');
        const ephemeral = interaction.options.getBoolean('ephemeral') || true;
        
        await interaction.deferReply({ ephemeral });
        hasResponded = true;
        
        // Validate inputs
        if (!user) {
          await interaction.editReply('❌ Please specify a user to remind.');
          return;
        }
        
        if (!message) {
          await interaction.editReply('❌ Please specify a reminder message.');
          return;
        }
        
        if (!time) {
          await interaction.editReply('❌ Please specify when to send the reminder.');
          return;
        }
        
        // Parse the time expression
        logToFile(`Parsing reminder time: "${time}" for user ${user.tag}`);
        let reminderDate = null;
        
        // Try GPT first if available
        if (openai) {
          logToFile(`Trying to parse date with GPT: "${time}"`);
          reminderDate = await parseDate(time);
          logToFile(`GPT parsed date: ${reminderDate}`);
        }
        
        // Fall back to manual parsing if GPT fails
        if (!reminderDate) {
          logToFile(`Trying to parse date manually: "${time}"`);
          reminderDate = manualDateParse(time);
          logToFile(`Manually parsed date: ${reminderDate}`);
        }
        
        // If date parsing failed, return an error
        if (!reminderDate) {
          await interaction.editReply(`❌ Could not parse the time: "${time}". Please use a more standard format like "30m", "1h", or "tomorrow at 3pm".`);
          return;
        }
        
        // Check if the date is in the past
        const now = new Date();
        if (reminderDate < now) {
          await interaction.editReply(`❌ The reminder time is in the past. Please choose a future time.`);
          return;
        }
        
        // Format date for display
        const formattedDate = reminderDate.toLocaleString('en-US', { 
          timeZone: TZ,
          weekday: 'short',
          month: 'short', 
          day: 'numeric',
          hour: '2-digit', 
          minute: '2-digit'
        });
        
        // Calculate time until reminder
        const msUntilReminder = reminderDate.getTime() - now.getTime();
        const secondsUntil = Math.floor(msUntilReminder / 1000);
        const minutesUntil = Math.floor(secondsUntil / 60);
        const hoursUntil = Math.floor(minutesUntil / 60);
        
        let timeUntilText = '';
        if (hoursUntil > 0) {
          timeUntilText = `${hoursUntil}h ${minutesUntil % 60}m`;
        } else {
          timeUntilText = `${minutesUntil}m ${secondsUntil % 60}s`;
        }
        
        // Generate reminder ID
        const reminderId = Math.floor(Math.random() * 10000) + 1;
        
        // Create the reminder message
        const reminderMessage = `⏰ **Reminder** for <@${user.id}>: ${message}\n(Set by <@${interaction.user.id}>)`;
        
        // Schedule the reminder
        setTimeout(() => {
          interaction.channel.send(reminderMessage)
            .then(() => logToFile(`Sent reminder #${reminderId} to ${user.tag}: "${message}"`))
            .catch(err => logToFile(`Error sending reminder: ${err.message}`));
        }, msUntilReminder);
        
        // Send confirmation message
        const embed = new EmbedBuilder()
          .setTitle('⏰ Reminder Scheduled')
          .setColor(0x00AAFF)
          .setDescription(`I'll remind <@${user.id}> with your message at the specified time.`)
          .addFields(
            { name: 'Message', value: message, inline: false },
            { name: 'When', value: formattedDate, inline: true },
            { name: 'Time until reminder', value: timeUntilText, inline: true },
            { name: 'Reminder ID', value: `#${reminderId}`, inline: true }
          )
          .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
        
        // Send non-ephemeral confirmation in the channel if ephemeral is false
        if (!ephemeral) {
          await interaction.channel.send(
            `✅ <@${interaction.user.id}> set a reminder for <@${user.id}> at ${formattedDate} (in ${timeUntilText})`
          );
        }
        
        logToFile(`Reminder #${reminderId} scheduled for ${user.tag} at ${formattedDate} (in ${timeUntilText}): "${message}"`);
      } catch (error) {
        logToFile(`Error in /remind command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error scheduling reminder: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error scheduling reminder: ${error.message}`, ephemeral: true });
        }
      }
    }
    
    // Handle the /check-tasks command
    else if (commandName === 'check-tasks') {
      try {
        // Always use ephemeral replies for this command
        await interaction.deferReply({ ephemeral: true });
        hasResponded = true;
        
        // Run the task check
        await interaction.editReply('⏳ Checking for completed tasks in recent messages...');
        
        const result = await checkEndOfDayTaskUpdates();
        
        if (!result.success) {
          return interaction.editReply(`❌ Error checking tasks: ${result.error}`);
        }
        
        if (result.skipped) {
          return interaction.editReply('Current time is before 16:00, but check was forced. No messages to process.');
        }
        
        if (result.messageCount === 0) {
          return interaction.editReply('No messages found in the 16:00-20:00 timeframe.');
        }
        
        // Create embed for response
        const embed = new EmbedBuilder()
          .setTitle('Task Update Check Complete')
          .setColor(0x00AA00)
          .setDescription(`I've analyzed messages from 16:00-20:00 to find completed tasks.`)
          .addFields(
            { name: 'Messages Analyzed', value: `${result.messageCount}`, inline: true },
            { name: 'Tasks Updated', value: `${result.updatedTasks}`, inline: true }
          )
          .setTimestamp();
        
        // Send the response
        await interaction.editReply({ 
          content: '✅ Task update check completed successfully!', 
          embeds: [embed] 
        });
        
      } catch (error) {
        logToFile(`Error in /check-tasks command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error checking tasks: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error checking tasks: ${error.message}`, ephemeral: true });
        }
      }
    }

    // Handle the /issue-report command
    else if (commandName === 'issue-report') {
      try {
        const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;
        await interaction.deferReply({ ephemeral });
        hasResponded = true;

        const timeframe = interaction.options.getString('timeframe') || 'week';
        await interaction.editReply('⏳ Generating issue report...');

        const files = await generateIssueReport(timeframe);
        if (!files) {
          await interaction.editReply('❌ Failed to generate report');
        } else {
          const attachments = [];
          attachments.push(new AttachmentBuilder(files.msgFile));
          attachments.push(new AttachmentBuilder(files.frameFile));
          if (files.changelogFile) attachments.push(new AttachmentBuilder(files.changelogFile));
          if (files.assignFile) attachments.push(new AttachmentBuilder(files.assignFile));
          await interaction.editReply({ content: '📄 Issue report generated', files: attachments });
        }
      } catch (error) {
        logToFile(`Error in /issue-report command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error generating report: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error generating report: ${error.message}`, ephemeral: true });
        }
      }
    }

    // Handle the /frameio command for testing Frame.io connectivity
    else if (commandName === 'frameio') {
      try {
        const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;
        await interaction.deferReply({ ephemeral });
        hasResponded = true;

        const timeframe = interaction.options.getString('timeframe') || 'week';
        const comments = await fetchFrameioComments(timeframe, { throwErrors: true });

        if (!comments || comments.length === 0) {
          await interaction.editReply('No Frame.io comments found in the selected timeframe.');
          return;
        }

        const text = comments.join('\n');
        if (text.length > 1900) {
          const dir = path.join(__dirname, 'issue-reports');
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filePath = path.join(dir, `frameio-test-${timestamp}.txt`);
          fs.writeFileSync(filePath, text, 'utf8');
          await interaction.editReply({ content: `Fetched ${comments.length} comments`, files: [new AttachmentBuilder(filePath)] });
        } else {
          await interaction.editReply(`Fetched ${comments.length} comments:\n${text}`);
        }
      } catch (error) {
        logToFile(`Error in /frameio command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true });
        }
      }
    }

    // Handle the /noad command
    else if (commandName === 'noad') {
      try {
        const userId = '493294607258484776';
        const user = await client.users.fetch(userId);
        await user.send('ur cool');
        await interaction.reply({ content: `DM sent to <@${userId}>`, ephemeral: true });
      } catch (error) {
        logToFile(`Error in /noad command: ${error.message}`);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true });
        } else if (interaction.deferred) {
          await interaction.editReply(`❌ ${error.message}`);
        }
      }
    }

    // Handle the /vo command
    else if (commandName === 'vo') {
      try {
        await interaction.deferReply();
        hasResponded = true;

        const text = interaction.options.getString('text');
        const selectedVoice = interaction.options.getString('voice');
        const apiKey = process.env.ELEVENLABS_API_KEY;
        const voiceId = selectedVoice || process.env.ELEVENLABS_VOICE_ID;

        if (!apiKey || !voiceId) {
          await interaction.editReply('❌ ElevenLabs API not configured.');
          return;
        }

        const response = await axios.post(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
          { text, model_id: 'eleven_multilingual_v2' },
          {
            headers: {
              'xi-api-key': apiKey,
              'Content-Type': 'application/json',
              Accept: 'audio/mpeg'
            },
            responseType: 'arraybuffer'
          }
        );

        const attachment = new AttachmentBuilder(Buffer.from(response.data), { name: 'voiceover.mp3' });
        await interaction.editReply({ content: '🗣️ Generated voiceover:', files: [attachment] });
      } catch (error) {
        logToFile(`Error in /vo command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true });
        }
      }
    }

    // Handle the /video command
    else if (commandName === 'video') {
      try {
        await interaction.deferReply();
        hasResponded = true;

        const prompt = interaction.options.getString('prompt');
        const image = interaction.options.getAttachment('image');
        const duration = interaction.options.getInteger('duration') || 5;
        const apiKey = process.env.RUNWAY_API_KEY;
        const model = RUNWAY_MODEL;

        if (!apiKey) {
          await interaction.editReply('❌ Runway API not configured.');
          return;
        }
        if (!model) {
          await interaction.editReply('❌ Runway model not configured.');
          return;
        }
        if (!image) {
          await interaction.editReply('❌ You must provide an image.');
          return;
        }

        const startResp = await axios.post(
          'https://api.dev.runwayml.com/v1/image_to_video',
          {
            model,
            promptImage: image.url,
            promptText: prompt,
            ratio: '1280:720',
            duration
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'X-Runway-Version': '2024-11-06'
            }
          }
        );

        const id = startResp.data.id;
        let status = startResp.data.status;
        let videoUrl;
        let attempts = 0;

        while (!['SUCCEEDED', 'FAILED'].includes(status?.toUpperCase()) && attempts < 30) {
          await new Promise(r => setTimeout(r, 5000));
          const poll = await axios.get(`https://api.dev.runwayml.com/v1/tasks/${id}`, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'X-Runway-Version': '2024-11-06'
            }
          });
          status = poll.data.status;
          if (status && status.toUpperCase() === 'SUCCEEDED') {
            videoUrl =
              poll.data.output?.[0] ||
              poll.data.output?.url ||
              poll.data.output_url ||
              poll.data.result?.[0] ||
              poll.data.result?.url ||
              poll.data.result;
          }
          attempts++;
        }

        if (status?.toUpperCase() !== 'SUCCEEDED' || !videoUrl) {
          await interaction.editReply('❌ Video generation failed.');
          return;
        }

        const videoResp = await axios.get(videoUrl, { responseType: 'arraybuffer' });
        const attachment = new AttachmentBuilder(Buffer.from(videoResp.data), { name: 'video.mp4' });
        await interaction.editReply({ content: '📹 Generated video:', files: [attachment] });
      } catch (error) {
        const msg = axiosErrorMessage(error, 'Runway video generation');
        logToFile(`Error in /video command: ${msg}`);
        if (hasResponded) {
          await interaction.editReply(`❌ ${msg}`);
        } else {
          await interaction.reply({ content: `❌ ${msg}`, ephemeral: true });
        }
      }
    }

    // Handle the /create command
    else if (commandName === 'create') {
      try {
        await interaction.deferReply();
        hasResponded = true;

        const userPrompt = interaction.options.getString('prompt');
        const attachmentOpt = interaction.options.getAttachment('image');

        if (!openai) {
          await interaction.editReply('❌ OpenAI API not configured.');
          return;
        }

        const stylePrompt = `${RED_MONOLITH_STYLE}\n${userPrompt}`;

        const input = [{ role: 'user', content: [{ type: 'input_text', text: stylePrompt }] }];

        if (attachmentOpt && attachmentOpt.contentType && attachmentOpt.contentType.startsWith('image/')) {
          const imgResp = await axios.get(attachmentOpt.url, { responseType: 'arraybuffer' });
          const base64 = Buffer.from(imgResp.data).toString('base64');
          input[0].content.push({ type: 'input_image', image_url: `data:${attachmentOpt.contentType};base64,${base64}` });
        }

        const params = {
          model: 'gpt-4o',
          input,
          tools: [{
            type: 'image_generation',
            partial_images: 2,
            size: '1536x1024',
            quality: 'high'
          }],
          stream: true
        };

        const previousId = lastImageResponses.get(interaction.user.id);
        if (previousId) params.previous_response_id = previousId;

        const stream = await openai.responses.create(params);

        let finalBuffer = null;
        let responseId = null;
        let partialMsg = null;

        for await (const event of stream) {
          if (event.partial_image_b64) {
            const idx = event.partial_image_index ?? 0;
            const buf = Buffer.from(event.partial_image_b64, 'base64');
            const partAttachment = new AttachmentBuilder(buf, { name: `partial_${idx}.png` });
            if (partialMsg) {
              partialMsg = await partialMsg.edit({ content: `⏳ Partial image ${idx + 1}`, files: [partAttachment] });
            } else {
              partialMsg = await interaction.followUp({ content: `⏳ Partial image ${idx + 1}`, files: [partAttachment], ephemeral: true });
            }
          }

          if (event.result) {
            responseId = event.id;
            finalBuffer = Buffer.from(event.result, 'base64');
          }
        }

        if (!finalBuffer) {
          logToFile('Streaming image generation returned no result. Falling back to images.generate');
          try {
            const gen = await openai.images.generate({
              model: 'dall-e-3',
              prompt: stylePrompt,
              n: 1,
              size: '1024x1024',
              response_format: 'b64_json'
            });
            const imgB64 = gen.data?.[0]?.b64_json;
            if (imgB64) {
              finalBuffer = Buffer.from(imgB64, 'base64');
              responseId = gen.created?.toString();
            }
          } catch (genErr) {
            logToFile(`Fallback image generation failed: ${genErr.message}`);
          }
        }

        if (!finalBuffer) {
          await interaction.editReply('❌ Image generation failed.');
          return;
        }

        lastImageResponses.set(interaction.user.id, responseId);
        const attachment = new AttachmentBuilder(finalBuffer, { name: 'image.png' });
        await interaction.editReply('✅ Image generation complete.');
        const finalMsg = await interaction.followUp({ content: `🖼️ Generated image (Response ID: ${responseId})`, files: [attachment] });
        imageResponseMap.set(finalMsg.id, responseId);
      } catch (error) {
        logToFile(`Error in /create command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true });
        }
      }
    }

    // Handle the /ask command
    else if (commandName === 'ask') {
      // Use the handleAskCommand function from knowledge-assistant.js
      await handleAskCommand(interaction);
    }

    // Handle the /creds command
    else if (commandName === 'creds') {
      const { creds, xp, level } = points.getBalance(interaction.user.id);
      await interaction.reply({
        content: `You have **${creds}** Creds and **${xp} XP** (Level ${level}).`,
        ephemeral: true
      });
    }

    // Handle the /kudos command
    else if (commandName === 'kudos') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      const reason = interaction.options.getString('reason');
      points.addCreds(target.id, amount, reason);
      await interaction.reply({
        content: `Awarded **${amount}** Creds to ${target} for "${reason}"`,
        allowedMentions: { users: [target.id] }
      });
    }

    // Handle the /dashboard command
    else if (commandName === 'dashboard') {
      try {
        const ephemeral = interaction.options.getBoolean('ephemeral') || false;
        await interaction.deferReply({ ephemeral });
        hasResponded = true;

        if (!notion) {
          await interaction.editReply('❌ Notion integration is not configured. Please ask an administrator to set up the Notion API token and database ID.');
          return;
        }

        const channel = interaction.channel;
        if (!channel) {
          await interaction.editReply('❌ This command can only be used in a text channel.');
          return;
        }

        const channelName = channel.name.toLowerCase();
        const codeMatch = channelName.match(/(ib|cl|bc)\d{2}/i);

        if (!codeMatch) {
          await interaction.editReply('❌ This channel does not appear to be linked to a project. Channel name should contain a project code like IB23, CL45, etc.');
          return;
        }

        const projectCode = codeMatch[0].toUpperCase();
        const result = await fetchProjectDeadlines(null, projectCode);

        if (!result.success || !result.projects || result.projects.length === 0) {
          await interaction.editReply(`❌ Could not fetch information for project ${projectCode}.`);
          return;
        }

        const project = result.projects[0];
        const embed = new EmbedBuilder()
          .setTitle(`📊 Dashboard for ${project.code}`)
          .setColor(0x00AAFF)
          .addFields(
            { name: 'Status', value: project.status || 'Unknown', inline: true },
            { name: 'Main Deadline', value: project.formattedMainDeadline || 'Not set', inline: true },
            { name: 'Stage Deadline', value: project.formattedStageDeadline || 'Not set', inline: true }
          )
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Open in Notion')
            .setStyle(ButtonStyle.Link)
            .setURL(project.notionUrl)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
      } catch (error) {
        logToFile(`Error in /dashboard command: ${error.message}`);
        if (hasResponded) {
          await interaction.editReply(`❌ Error generating dashboard: ${error.message}`);
        } else {
          await interaction.reply({ content: `❌ Error generating dashboard: ${error.message}`, ephemeral: true });
        }
      }
    }

    // Handle the /shop command
    else if (commandName === 'shop') {
      const items = rewards.map(r => `**${r.name}** - ${r.cost} Creds`).join('\n');
      await interaction.reply({ content: `Available rewards:\n${items}`, ephemeral: true });
    }

    // Handle the /redeem command
    else if (commandName === 'redeem') {
      const itemName = interaction.options.getString('item');
      const reward = rewards.find(r => r.name.toLowerCase() === itemName.toLowerCase());
      if (!reward) {
        await interaction.reply({ content: 'Item not found.', ephemeral: true });
      } else if (!points.spendCreds(interaction.user.id, reward.cost, `Redeemed ${reward.name}`)) {
        await interaction.reply({ content: 'Not enough Creds.', ephemeral: true });
      } else {
        await interaction.reply({ content: `You redeemed **${reward.name}** for ${reward.cost} Creds!`, ephemeral: true });
      }
    }

    // Handle the /incoming-email command
    else if (commandName === 'incoming-email') {
      const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;
      const instructions = EMAIL_CHANNEL_ID
        ? `Configure your email provider to POST to \`/incoming-email\`. Emails will be forwarded to <#${EMAIL_CHANNEL_ID}>.`
        : 'Email forwarding is not configured. Set EMAIL_CHANNEL_ID in the environment variables.';
      await interaction.reply({ content: instructions, ephemeral });
    }
    
    // Other commands here
    // ...
    
  } catch (globalError) {
    logToFile(`Global error handler caught: ${globalError.message}`);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `❌ An error occurred: ${globalError.message}`, ephemeral: true });
      } else if (interaction.deferred) {
        await interaction.editReply(`❌ An error occurred: ${globalError.message}`);
      }
    } catch (replyError) {
      logToFile(`Failed to send error reply: ${replyError.message}`);
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
module.exports = { client, notion, findProjectByQuery, getNotionPageUrl, fetchProjectDeadlines, generateIssueReport, fetchProjectAssignments };

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
        
        // Special handling for the message backup job
        if (job.backupMessages) {
          logToFile(`Starting backup of messages from channel ${MESSAGE_BACKUP_CHANNEL_ID}`);
          await backupChannelMessages();
          return;
        }

        // Special handling for automatic task extraction
        if (job.extractTasks) {
          logToFile(`Starting automatic task extraction`);
          const result = await extractTasksFromMorningMessages();
          if (result.success) {
            logToFile(`Automatic task extraction complete. Messages: ${result.messageCount}, tasks: ${result.taskCount}`);
          } else {
            logToFile(`❌ Error in automatic task extraction: ${result.error || 'Unknown error'}`);
          }
          return;
        }
        
        // Special handling for the task update job
        if (job.updateTasks) {
          logToFile(`Starting end-of-day task update check`);
          const result = await checkEndOfDayTaskUpdates();
          if (result.success) {
            logToFile(`End-of-day task check completed. Updated ${result.updatedTasks || 0} tasks.`);
          } else {
            logToFile(`❌ Error in end-of-day task check: ${result.error || 'Unknown error'}`);
          }
          return;
        }

        // Special handling for stale VA Review projects
        if (job.checkVaReview) {
          logToFile('Starting stale VA Review check');
          const result = await checkStaleVaReview();
          if (!result.success) {
            logToFile(`❌ Error in VA review check: ${result.error}`);
          } else {
            logToFile(`VA review check notified ${result.notified || 0} projects`);
          }
          return;
        }
        
        // Regular job execution for notification messages
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

// Function to determine the correct Status property format for a page
function getStatusPropertyFormat(pageProperties) {
  // Check if the Status property exists and what type it is
  if (pageProperties.Status) {
    // Look for evidence of being a status-type property
    if ('status' in pageProperties.Status) {
      return 'status';
    } 
    // Look for evidence of being a select-type property
    else if ('select' in pageProperties.Status) {
      return 'select';
    }
  }
  
  // Default to status format based on error message "Status is expected to be status"
  return 'status';
}

// Create a helper function to properly update Status property
async function updateNotionStatus(pageId, statusValue) {
  try {
    // Using the direct format that Notion expects
    const updateObj = {
      properties: {
        Status: {
          status: {
            name: statusValue
          }
        }
      }
    };
    
    // Perform the update with simple status format
    logToFile(`Updating status for page ${pageId} with value "${statusValue}" using direct format`);
    
    const response = await notion.pages.update({
      page_id: pageId,
      ...updateObj
    });
    
    logToFile(`Successfully updated status to "${statusValue}"`);
    return { success: true, data: response };
  } catch (error) {
    logToFile(`❌ ERROR updating status: ${error.message}`);
    logToFile(`❌ ERROR details: ${JSON.stringify(error, null, 2)}`);
    
    // Try alternative format (select instead of status)
    try {
      logToFile(`Trying alternative select format for status...`);
      const alternativeFormat = {
        properties: {
          Status: {
            select: {
              name: statusValue
            }
          }
        }
      };
      
      const response = await notion.pages.update({
        page_id: pageId,
        ...alternativeFormat
      });
      
      logToFile(`✅ Successfully updated status using select format`);
      return { success: true, data: response };
    } catch (retryError) {
      logToFile(`❌ Both status formats failed. Second error: ${retryError.message}`);
      return { success: false, error };
    }
  }
}

// Add this after the getNotionPageUrl function

// Function to backup messages from a channel between specific times
async function backupChannelMessages() {
  try {
    logToFile(`=== Starting Daily Message Backup ===`);
    
    // Get the channel
    const channel = client.channels.cache.get(MESSAGE_BACKUP_CHANNEL_ID);
    if (!channel) {
      logToFile(`❌ Error: Channel with ID ${MESSAGE_BACKUP_CHANNEL_ID} not found!`);
      return;
    }
    
    logToFile(`Found channel #${channel.name} (${channel.id})`);
    
    // Calculate today's 8 AM in the configured timezone
    const now = new Date();
    const today = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
    today.setHours(8, 0, 0, 0);
    
    // Convert to UTC for comparison with Discord timestamps
    const startTime = new Date(today.toLocaleString('en-US', { timeZone: 'UTC' }));
    
    logToFile(`Collecting messages since ${startTime.toISOString()} (8 AM in ${TZ})`);
    
    try {
      // Fetch the last 100 messages from the channel
      const messages = await channel.messages.fetch({ limit: 100 });
      
      // Filter messages sent after 8 AM today
      const recentMessages = messages.filter(msg => new Date(msg.createdAt) >= startTime);

      logToFile(`Found ${recentMessages.size} messages sent since 8 AM`);
      
      if (recentMessages.size === 0) {
        logToFile(`No new messages to backup.`);
        return;
      }
      
      // Format messages for saving
      const formattedMessages = recentMessages.map(msg => ({
        id: msg.id,
        author: {
          id: msg.author.id,
          username: msg.author.username,
          tag: msg.author.tag
        },
        content: msg.content,
        attachments: msg.attachments.size > 0 ? [...msg.attachments.values()].map(a => a.url) : [],
        timestamp: msg.createdAt.toISOString()
      }));
      
      // Group messages by author for summarization
      const messagesByAuthor = {};
      formattedMessages.forEach(msg => {
        const authorId = msg.author.id;
        if (!messagesByAuthor[authorId]) {
          messagesByAuthor[authorId] = {
            author: msg.author,
            messages: []
          };
        }
        messagesByAuthor[authorId].messages.push({
          content: msg.content,
          timestamp: msg.timestamp
        });
      });
      
      // Create timestamp for the filename
      const dateStr = now.toISOString().split('T')[0];
      const backupFileName = `message_backup_${dateStr}.json`;
      const backupFilePath = path.join(__dirname, 'backups', backupFileName);
      
      // Ensure backups directory exists
      if (!fs.existsSync(path.join(__dirname, 'backups'))) {
        fs.mkdirSync(path.join(__dirname, 'backups'));
      }
      
      // Write messages to JSON file
      fs.writeFileSync(
        backupFilePath, 
        JSON.stringify({ 
          channel: {
            id: channel.id,
            name: channel.name
          },
          backupDate: now.toISOString(),
          messageCount: formattedMessages.length,
          messages: formattedMessages 
        }, null, 2)
      );
      
      logToFile(`✅ Successfully backed up ${formattedMessages.length} messages to ${backupFilePath}`);
      
      // Also write a plaintext version for easy reading
      const textContent = formattedMessages
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
        .map(msg => `[${new Date(msg.timestamp).toLocaleString()}] ${msg.author.tag}: ${msg.content}`)
        .join('\n\n');
      
      const textFilePath = path.join(__dirname, 'backups', `message_backup_${dateStr}.txt`);
      fs.writeFileSync(textFilePath, textContent);
      
      logToFile(`✅ Also saved plaintext version to ${textFilePath}`);
      
      // Generate AI summary if OpenAI is configured
      if (openai) {
        logToFile(`Generating AI summary of messages...`);
        
        const summaryPrompt = generateSummaryPrompt(messagesByAuthor);
        
        try {
          const aiResponse = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
              {
                role: 'system',
                content: `You are an assistant that summarizes Discord conversations into actionable items.
                For each user, extract clear, actionable tasks from their messages.
                Format each item as a bullet point starting with "ACTION:" for definite actions needed,
                "INFO:" for important information shared, or "DECISION:" for decisions made.
                Group items by user and be concise - focus only on important, actionable content.`
              },
              {
                role: 'user',
                content: summaryPrompt
              }
            ],
            temperature: 0.3,
            max_tokens: 1500
          });
          
          const summary = aiResponse.choices[0]?.message?.content;
          
          if (summary) {
            // Save the AI summary
            const summaryFilePath = path.join(__dirname, 'backups', `summary_${dateStr}.md`);
            const summaryHeader = `# Daily Message Summary - ${new Date().toLocaleDateString('en-US', { timeZone: TZ })}\n\n`;
            const channelInfo = `**Channel:** #${channel.name}\n**Time Period:** 8:00 AM - 11:00 AM ${TZ}\n**Message Count:** ${formattedMessages.length}\n\n`;
            
            fs.writeFileSync(summaryFilePath, summaryHeader + channelInfo + summary);
            logToFile(`✅ Successfully created AI summary at ${summaryFilePath}`);
            
            // Also try to send the summary to the channel
            try {
              const summaryEmbed = new EmbedBuilder()
                .setTitle('Morning Message Summary')
                .setDescription('AI-generated summary of this morning\'s conversation')
                .setColor(0x00AAFF)
                .addFields({ name: 'Time Period', value: '8:00 AM - 11:00 AM', inline: true })
                .addFields({ name: 'Message Count', value: `${formattedMessages.length}`, inline: true })
                .setTimestamp();
              
              // Split summary if it's too long for Discord (max 4096 chars for description)
              if (summary.length <= 4000) {
                summaryEmbed.setDescription(summary);
                await channel.send({ embeds: [summaryEmbed] });
              } else {
                // Send the first part in the embed
                summaryEmbed.setDescription(summary.substring(0, 4000) + '...\n*(Summary continued in file attachment)*');
                
                // Send the full summary as a file attachment
                const summaryAttachment = Buffer.from(summary, 'utf8');
                const attachment = { attachment: summaryAttachment, name: 'morning_summary.md' };
                
                await channel.send({ 
                  embeds: [summaryEmbed],
                  files: [attachment]
                });
              }
              
              logToFile(`✅ Successfully sent AI summary to channel`);
            } catch (sendError) {
              logToFile(`⚠️ Could not send summary to channel: ${sendError.message}`);
            }
          } else {
            logToFile(`⚠️ AI returned empty summary`);
          }
        } catch (aiError) {
          logToFile(`❌ Error generating AI summary: ${aiError.message}`);
        }
      } else {
        logToFile(`⚠️ OpenAI not configured, skipping AI summary generation`);
      }
      
    } catch (fetchError) {
      logToFile(`❌ Error fetching messages: ${fetchError.message}`);
      throw fetchError;
    }
    
    logToFile(`=== Daily Message Backup Completed ===`);
  } catch (error) {
    logToFile(`❌ Error in backupChannelMessages: ${error.message}`);
    console.error('Error in message backup:', error);
  }
}

// Helper function to generate the prompt for AI summarization
function generateSummaryPrompt(messagesByAuthor) {
  let prompt = `Please summarize the following Discord messages into actionable items by user.\n\n`;
  
  Object.keys(messagesByAuthor).forEach(authorId => {
    const authorData = messagesByAuthor[authorId];
    prompt += `## User: ${authorData.author.tag}\n\n`;
    
    // Sort messages by timestamp
    const sortedMessages = authorData.messages.sort((a, b) => 
      new Date(a.timestamp) - new Date(b.timestamp)
    );
    
    // Add messages with timestamps
    sortedMessages.forEach(msg => {
      const time = new Date(msg.timestamp).toLocaleTimeString('en-US', { 
        timeZone: TZ,
        hour: '2-digit',
        minute: '2-digit'
      });
      prompt += `[${time}] ${msg.content}\n\n`;
    });
    
    prompt += `\n`;
  });
  
  prompt += `\nFor each user, extract actionable items, important information shared, and decisions made from their messages.
Format as bullet points with "ACTION:", "INFO:", or "DECISION:" prefixes.
Focus only on important content and be concise.`;
  
  return prompt;
}

// After the function to schedule backup job
function scheduleBackupJob() {
  // Schedule at 11 AM every day
  cron.schedule('0 11 * * *', async () => {
    try {
      logToFile(`⏰ Executing daily message backup and task extraction at ${moment().tz(TZ).format('YYYY-MM-DD HH:mm:ss')}`);
      await backupAndProcessMessages();
    } catch (error) {
      logToFile(`❌ Error executing daily backup job: ${error.message}`);
      console.error('Error in daily backup job:', error);
    }
  }, {
    timezone: TZ,
    scheduled: true
  });
  
  logToFile(`✅ Scheduled daily message backup job for 11:00 AM ${TZ}`);
}

// Function to extract tasks from morning messages and create Notion pages
async function extractTasksFromMorningMessages() {
  try {
    logToFile(`=== Starting Manual Task Extraction ===`);
    
    // Get the channel
    const channel = client.channels.cache.get(MESSAGE_BACKUP_CHANNEL_ID);
    if (!channel) {
      logToFile(`❌ Error: Channel with ID ${MESSAGE_BACKUP_CHANNEL_ID} not found!`);
      return { success: false, error: "Channel not found" };
    }
    
    logToFile(`Found channel #${channel.name} (${channel.id})`);
    
    // Calculate today's 8 AM in the configured timezone
    const now = new Date();
    const today = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
    today.setHours(8, 0, 0, 0);
    
    // Convert to UTC for comparison with Discord timestamps
    const startTime = new Date(today.toLocaleString('en-US', { timeZone: 'UTC' }));
    
    logToFile(`Collecting messages since ${startTime.toISOString()} (8 AM in ${TZ})`);
    
    try {
      // Fetch the last 100 messages from the channel
      const messages = await channel.messages.fetch({ limit: 100 });
      
      // Filter messages sent after 8 AM today
      const recentMessages = messages.filter(msg => new Date(msg.createdAt) >= startTime);

      logToFile(`Found ${recentMessages.size} messages sent since 8 AM`);
      
      if (recentMessages.size === 0) {
        logToFile(`No new messages to process.`);
        return { success: true, messageCount: 0, taskCount: 0, pagesCreated: 0 };
      }
      
      // Sample message content for debugging
      if (recentMessages.size > 0) {
        const sampleMessages = [...recentMessages.values()].slice(0, 3);
        sampleMessages.forEach((msg, idx) => {
          logToFile(`Sample message ${idx+1}: ${msg.author.tag}: ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}`);
        });
      }
      
      // Extract tasks by author
      const tasksByAuthor = await extractTasksByAuthor(recentMessages);
      
      // Log the users and their tasks
      logToFile(`Task extraction results by user:`);
      for (const [authorId, authorData] of Object.entries(tasksByAuthor)) {
        logToFile(`User ${authorData.author.tag}: ${authorData.tasks.length} tasks found`);
        authorData.tasks.forEach((task, idx) => {
          logToFile(`  Task ${idx+1}: ${task}`);
        });
      }
      
      // Create Notion pages for each task
      let totalPagesCreated = 0;
      let authorCount = 0;
      
      for (const [authorId, authorData] of Object.entries(tasksByAuthor)) {
        if (authorData.tasks.length > 0) {
          // createNotionTaskPage now returns an array of created pages
          const createdPages = await createNotionTaskPage(authorData);
          
          // Increment counters
          if (createdPages && createdPages.length > 0) {
            totalPagesCreated += createdPages.length;
            authorCount++;
            
            logToFile(`Created ${createdPages.length} task pages for ${authorData.author.tag}`);
          }
        }
      }
      
      // Count total tasks
      const totalTasks = Object.values(tasksByAuthor).reduce(
        (sum, user) => sum + user.tasks.length, 0
      );

      // Estimate points for each task and store
      let summaryLines = [];
      for (const [authorId, authorData] of Object.entries(tasksByAuthor)) {
        for (const desc of authorData.tasks) {
          const points = await estimateTaskPoints(desc);
          addTask({
            id: Date.now().toString() + Math.random().toString(16).slice(2, 6),
            userId: authorId,
            description: desc,
            points,
            completed: false
          });
          summaryLines.push(`• (${points} pts) ${desc} — <@${authorId}>`);
        }
      }

      if (TODO_CHANNEL_ID) {
        const todoChannel = client.channels.cache.get(TODO_CHANNEL_ID);
        if (todoChannel && summaryLines.length > 0) {
          let message = `**Today's Tasks**\n` + summaryLines.join('\n');
          if (NOTION_TASKS_URL) {
            message += `\n\n<${NOTION_TASKS_URL}>`;
          }
          await todoChannel.send(message);
        }
      }
      
      logToFile(`✅ Task extraction completed: Created ${totalPagesCreated} individual Notion task pages for ${authorCount} team members (${totalTasks} total tasks)`);
      
      return {
        success: true,
        messageCount: recentMessages.size,
        taskCount: totalTasks,
        pagesCreated: totalPagesCreated,
        authors: authorCount
      };
      
    } catch (fetchError) {
      logToFile(`❌ Error fetching messages: ${fetchError.message}`);
      throw fetchError;
    }
  } catch (error) {
    logToFile(`❌ Error in extractTasksFromMorningMessages: ${error.message}`);
    if (error.stack) {
      logToFile(`Stack trace: ${error.stack}`);
    }
    console.error('Error extracting tasks:', error);
    return { success: false, error: error.message };
  }
}

// Function to extract tasks from messages grouped by author
async function extractTasksByAuthor(messages) {
  const tasksByAuthor = {};
  
  // Convert messages collection to array and sort by time
  const sortedMessages = [...messages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );
  
  for (const msg of sortedMessages) {
    // Skip bot messages
    if (msg.author.bot) continue;
    
    const authorId = msg.author.id;
    const content = msg.content;
    
    // Skip empty messages
    if (!content.trim()) continue;
    
    // Initialize author data if not exists
    if (!tasksByAuthor[authorId]) {
      tasksByAuthor[authorId] = {
        author: {
          id: authorId,
          username: msg.author.username,
          tag: msg.author.tag,
        },
        tasks: [],
        projectCode: null,
        rawMessages: []
      };
    }
    
    // Add the raw message for context
    tasksByAuthor[authorId].rawMessages.push({
      content,
      timestamp: msg.createdTimestamp
    });
    
    // Extract project code if present (BC##, IB##, CL##)
    const projectMatch = content.match(/\b(BC|IB|CL)\s*(\d{2})\b/gi);
    if (projectMatch && !tasksByAuthor[authorId].projectCode) {
      tasksByAuthor[authorId].projectCode = projectMatch[0].replace(/\s+/g, '').toUpperCase();
    }
  }
  
  // Once we have collected all messages by author, use GPT to extract tasks
  if (openai) {
    for (const [authorId, authorData] of Object.entries(tasksByAuthor)) {
      if (authorData.rawMessages.length > 0) {
        try {
          // Create a context string from all messages
          const contextStr = authorData.rawMessages
            .map(msg => `[${moment(msg.timestamp).tz(TZ).format('HH:mm')}] ${msg.content}`)
            .join('\n\n');
            
          // Extract tasks using GPT-4o with context awareness
          const extractedTasks = await extractTasksWithGPT(contextStr, authorData.author.username);
          
          if (extractedTasks && extractedTasks.length > 0) {
            authorData.tasks = extractedTasks;
            logToFile(`✅ Successfully extracted ${extractedTasks.length} tasks for ${authorData.author.tag} using GPT`);
          } else {
            // Fallback to regex extraction if GPT returns no tasks
            const tasks = extractTasksFromContent(contextStr);
            authorData.tasks = tasks;
            logToFile(`ℹ️ Falling back to regex extraction for ${authorData.author.tag}: ${tasks.length} tasks found`);
          }
        } catch (error) {
          logToFile(`❌ Error using GPT for task extraction: ${error.message}. Falling back to regex.`);
          // Fallback to regex-based extraction for this user
          for (const msg of authorData.rawMessages) {
            const tasks = extractTasksFromContent(msg.content);
            if (tasks.length > 0) {
              authorData.tasks.push(...tasks);
            }
          }
        }
      }
    }
  } else {
    // If OpenAI is not available, fall back to regex extraction
    logToFile(`OpenAI client not available, using regex-based task extraction`);
    for (const [authorId, authorData] of Object.entries(tasksByAuthor)) {
      for (const msg of authorData.rawMessages) {
        const tasks = extractTasksFromContent(msg.content);
        if (tasks.length > 0) {
          authorData.tasks.push(...tasks);
        }
      }
    }
  }
  
  return tasksByAuthor;
}

// Function to extract tasks using GPT-4o
async function extractTasksWithGPT(messageContent, username) {
  try {
    logToFile(`Attempting to extract tasks using GPT for user ${username}`);
    const systemPrompt = `
You are a task extraction assistant that identifies tasks and goals from Discord messages.
Your role is to intelligently extract tasks while preserving their context and project associations.

GUIDELINES:
1. Preserve project context (e.g., "Storyn project (Sherlock)" should be part of the task context)
2. Identify project codes like BC32, IB15, CL47 and keep them with related tasks
3. Consider timeframes mentioned (e.g., "complete by 11:00") as part of the task, not separate tasks
4. Group related bullet points under their common project or context
5. Distinguish between actual tasks/to-dos and informational statements
6. Preserve the hierarchical relationship between main tasks and subtasks
7. Ignore greetings, casual chat, or non-task content
8. Be generous in identifying tasks - if something could be a task, include it

OUTPUT FORMAT:
Return a JSON object with a "tasks" array of task strings:
{
  "tasks": [
    "Project X: Task description with timeframe",
    "Context Y: Specific action item",
    ...
  ]
}

The user will provide the message content to analyze.`;

    const userPrompt = `Extract tasks from the following Discord messages by ${username}:\n\n${messageContent}`;

    logToFile(`Sending request to OpenAI with ${messageContent.length} characters of content`);

    // Call GPT-4o (or fall back to GPT-4 if available)
    const modelToUse = 'gpt-4o';
    const response = await openai.chat.completions.create({
      model: modelToUse,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2, // Low temperature for more consistent results
      response_format: { type: 'json_object' }
    });

    // Extract and parse the tasks
    const content = response.choices[0]?.message?.content || '';
    logToFile(`Received response from OpenAI (${content.length} characters)`);
    
    try {
      // Parse JSON response
      const parsedResponse = JSON.parse(content);
      
      // Return the tasks array or empty array if not found
      const tasks = parsedResponse.tasks || [];
      
      if (tasks.length > 0) {
        logToFile(`Successfully extracted ${tasks.length} tasks from GPT response`);
        tasks.forEach(task => logToFile(`GPT task: ${task}`));
        return tasks;
      } else {
        logToFile(`GPT returned zero tasks, trying alternative parsing methods`);
      }
    } catch (parseError) {
      logToFile(`Error parsing GPT response as JSON: ${parseError.message}`);
      logToFile(`Response content: ${content}`);
      
      // Try to extract tasks with regex as a fallback
      logToFile(`Attempting to extract tasks via regex pattern matching`);
      
      // Try to extract arrays of items that look like JSON arrays
      const arrayMatch = content.match(/\[\s*"(.+?)"\s*(?:,\s*"(.+?)"\s*)*\]/gs);
      if (arrayMatch) {
        logToFile(`Found array-like structure in response`);
        try {
          const arrayContent = arrayMatch[0];
          const parsedArray = JSON.parse(arrayContent);
          if (Array.isArray(parsedArray) && parsedArray.length > 0) {
            logToFile(`Successfully parsed array with ${parsedArray.length} tasks`);
            return parsedArray;
          }
        } catch (arrayParseError) {
          logToFile(`Error parsing array structure: ${arrayParseError.message}`);
        }
      }
      
      // Try to extract tasks using quotes
      const taskMatches = content.match(/"([^"]+)"/g);
      if (taskMatches && taskMatches.length > 0) {
        const extractedTasks = taskMatches.map(match => match.replace(/^"|"$/g, ''));
        logToFile(`Extracted ${extractedTasks.length} tasks using quote pattern matching`);
        return extractedTasks;
      }
      
      // Try to extract tasks using bullet points
      const bulletMatches = content.match(/(?:^|\n)(?:\d+[\.\)]\s*|\*\s*|-\s*|•\s*)(.+?)(?=\n|$)/gm);
      if (bulletMatches && bulletMatches.length > 0) {
        const extractedTasks = bulletMatches.map(match => 
          match.replace(/(?:^|\n)(?:\d+[\.\)]\s*|\*\s*|-\s*|•\s*)/, '').trim()
        );
        logToFile(`Extracted ${extractedTasks.length} tasks using bullet point pattern matching`);
        return extractedTasks;
      }
      
      // If we still can't extract tasks, use our regex task extractor
      logToFile(`Falling back to standard content task extraction`);
      return extractTasksFromContent(content);
    }
    
    // If we got this far with no tasks, use the regular task extractor
    logToFile(`No tasks found in GPT response, falling back to content task extraction`);
    return extractTasksFromContent(messageContent);
  } catch (error) {
    logToFile(`Error calling OpenAI for task extraction: ${error.message}`);
    logToFile(`Falling back to content task extraction due to API error`);
    return extractTasksFromContent(messageContent);
  }
}

// Function to extract tasks from message content
function extractTasksFromContent(content) {
  const tasks = [];
  logToFile(`Analyzing content for tasks: ${content.substring(0, 100)}...`);
  
  // Check for numbered lists (1. Task, 2. Task) - more flexible pattern
  const numberedItems = content.match(/(?:^|\n)\s*\d+\s*[\)\.]\s*(.+?)(?=\n\s*\d+\s*[\)\.]\s*|\n\s*$|$)/gs);
  if (numberedItems) {
    logToFile(`Found ${numberedItems.length} numbered items`);
    numberedItems.forEach(item => {
      const taskText = item.replace(/^\s*\d+\s*[\)\.]\s*/, '').trim();
      if (taskText) {
        logToFile(`Adding numbered task: ${taskText}`);
        tasks.push(taskText);
      }
    });
  }
  
  // Check for dash or bullet lists (-, •, *, etc)
  const bulletItems = content.match(/(?:^|\n)\s*[-•*]\s+(.+?)(?=\n\s*[-•*]\s+|\n\s*$|$)/gs);
  if (bulletItems) {
    logToFile(`Found ${bulletItems.length} bullet items`);
    bulletItems.forEach(item => {
      const taskText = item.replace(/^\s*[-•*]\s+/, '').trim();
      if (taskText) {
        logToFile(`Adding bullet task: ${taskText}`);
        tasks.push(taskText);
      }
    });
  }
  
  // Look for explicit task markers like "TODO:", "TASK:", etc.
  const explicitTasks = content.match(/(?:TODO|TASK|GOAL|need to|needs to|have to|should)(?::|to)?\s*(.+?)(?=\n|$)/gi);
  if (explicitTasks) {
    logToFile(`Found ${explicitTasks.length} explicit tasks`);
    explicitTasks.forEach(item => {
      const taskText = item.replace(/^(?:TODO|TASK|GOAL|need to|needs to|have to|should)(?::|to)?\s*/i, '').trim();
      if (taskText) {
        logToFile(`Adding explicit task: ${taskText}`);
        tasks.push(taskText);
      }
    });
  }
  
  // Look for "goals" format like "Today's goals:"
  if (content.toLowerCase().includes("goal") || content.toLowerCase().includes("plan") || content.toLowerCase().includes("todo") || content.toLowerCase().includes("to do")) {
    logToFile(`Found goals/plans/todos section`);
    // Extract lines that look like tasks after "goals" or "plans" header
    const goalMatch = content.match(/(?:today'?s?\s+(?:goals?|plans?|todos?|to\s+dos?)|goals?|plans?|todos?|to\s+dos?|plan\s+for)\s*:?\s*(?:\n|$)([\s\S]*)/i);
    if (goalMatch && goalMatch[1]) {
      const goalSection = goalMatch[1].trim();
      
      // Split into lines and process each line
      const lines = goalSection.split('\n');
      logToFile(`Found ${lines.length} lines in goals section`);
      lines.forEach(line => {
        // Clean up the line
        let taskText = line.trim()
          .replace(/^\s*[-•*]\s+/, '') // Remove bullet points
          .replace(/^\s*\d+\s*[\)\.]\s*/, '') // Remove numbering
          .replace(/^\s*[✓✔]\s*/, ''); // Remove checkmarks
        
        if (taskText && !taskText.match(/^(today'?s?\s+goals?|goals?|plans?|plan for|todos?|to\s+dos?)/i) && taskText.length > 3) {
          logToFile(`Adding goal/plan task: ${taskText}`);
          tasks.push(taskText);
        }
      });
    }
  }
  
  // Special handling for format like "BC32: MGX DRAFT / Clip Selection Finish all MGX BY EOD"
  const projectTaskMatch = content.match(/\b(BC|IB|CL)\s*(\d{2})\s*:\s*([\s\S]*?)(?=\n\s*(?:\b(?:BC|IB|CL)|$)|$)/gi);
  if (projectTaskMatch) {
    logToFile(`Found ${projectTaskMatch.length} project-specific task sections`);
    projectTaskMatch.forEach(match => {
      const projectCode = match.match(/\b(BC|IB|CL)\s*(\d{2})\b/i)[0].replace(/\s+/g, '').toUpperCase();
      
      // Get the content after the project code
      const taskContent = match.replace(/\b(BC|IB|CL)\s*(\d{2})\s*:/i, '').trim();
      
      // Split by line breaks, slashes or other common separators
      const taskParts = taskContent.split(/\n|\/|;|,/);
      
      taskParts.forEach(part => {
        const taskText = part.trim();
        if (taskText) {
          const fullTask = `${projectCode}: ${taskText}`;
          logToFile(`Adding project task: ${fullTask}`);
          tasks.push(fullTask);
        }
      });
    });
  }
  
  // Treat lines with action verbs at the beginning as potential tasks
  const actionLines = content.match(/(?:^|\n)\s*(?:finish|update|create|write|review|check|fix|implement|add|remove|change|prepare)\s+[^.,;:\n]+/gi);
  if (actionLines) {
    logToFile(`Found ${actionLines.length} action verb lines`);
    actionLines.forEach(line => {
      const taskText = line.trim();
      if (taskText && !tasks.includes(taskText) && taskText.length > 5) {
        logToFile(`Adding action verb task: ${taskText}`);
        tasks.push(taskText);
      }
    });
  }
  
  // Also consider any short lines (between 15-100 chars) that aren't already included as potential tasks
  // This is a fallback to catch casual task descriptions
  const lines = content.split('\n');
  lines.forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine.length > 15 && trimmedLine.length < 100 && 
        !tasks.includes(trimmedLine) && 
        !trimmedLine.startsWith('http') && 
        !trimmedLine.match(/^\[[\d:]+\]/) && // skip timestamps
        trimmedLine.match(/[a-z]/i)) { // ensure it has at least one letter
      logToFile(`Adding fallback task: ${trimmedLine}`);
      tasks.push(trimmedLine);
    }
  });
  
  const uniqueTasks = Array.from(new Set(tasks.filter(task => task.length > 0)));
  logToFile(`Extracted ${uniqueTasks.length} total tasks from content`);
  return uniqueTasks;
}

// Estimate story points for a task using GPT-4o
async function estimateTaskPoints(description) {
  if (!openai) return 1;

  try {
    const systemPrompt = 'You estimate effort for short tasks with a number 1-5.';
    const userPrompt = `Task: "${description}"`;
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });
    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return parsed.points || 1;
  } catch (err) {
    logToFile(`Error estimating points: ${err.message}`);
    return 1;
  }
}

// Function to create individual Notion task pages
async function createNotionTaskPage(authorData) {
  try {
    const { author, tasks, projectCode, rawMessages } = authorData;
    
    // Skip if no tasks
    if (tasks.length === 0) {
      logToFile(`No tasks found for ${author.tag}, skipping Notion page creation`);
      return null;
    }
    
    // Name aliases mapping for Discord usernames to actual names
    const nameAliases = {
      'ayoub_prods': 'Ayoub',
      'yovcheff.': 'Yovcho',
      'arminnemeth': 'Armin',
      'shadew_': 'Shadew',
      'wisedumdum': 'Jokubas',
      'amino1473': 'Amino'
    };
    
    // Get the proper name using the alias mapping, or use the original username if no alias exists
    const properName = nameAliases[author.username.toLowerCase()] || author.username;
    
    // Get today's date in ISO format for the Date property
    const todayISO = moment().tz(TZ).format('YYYY-MM-DD');
    
    // Use the specific database ID for tasks
    const TASKS_DB_ID = '1e787c20070a80319db0f8a08f255c3c';
    
    // Store created pages
    const createdPages = [];
    
    // Create a Notion page for each task
    for (const taskText of tasks) {
      try {
        logToFile(`Creating Notion page for task: "${taskText}" assigned to ${properName}`);
        
        // Create the Notion page for this individual task
        const response = await notion.pages.create({
          parent: {
            database_id: TASKS_DB_ID
          },
          properties: {
            // Set the task text as the title
            title: {
              title: [
                {
                  text: {
                    content: taskText
                  }
                }
              ]
            },
            // Set today's date in the Date field
            Date: {
              date: {
                start: todayISO
              }
            },
            // Assign the proper team member using the Assignee property
            Assignee: {
              select: {
                name: properName
              }
            },
            // Set initial Progress status to "To Do"
            Progress: {
              select: {
                name: "To Do"
              }
            }
          },
          // Add the original message as context in the page content
          children: [
            {
              object: "block",
              type: "heading_3",
              heading_3: {
                rich_text: [
                  {
                    text: {
                      content: "Original Messages"
                    }
                  }
                ]
              }
            },
            ...rawMessages.map(msg => ({
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: [
                  {
                    text: {
                      content: `[${moment(msg.timestamp).tz(TZ).format('HH:mm')}] ${msg.content}`
                    }
                  }
                ]
              }
            }))
          ]
        });
        
        createdPages.push(response);
        logToFile(`✅ Successfully created task page: "${taskText}" for ${properName}. Page ID: ${response.id}`);
      }
      catch (taskError) {
        logToFile(`❌ Error creating task page for "${taskText}": ${taskError.message}`);
        // Continue with other tasks even if one fails
      }
    }
    
    logToFile(`Created ${createdPages.length} individual task pages for ${properName}`);
    return createdPages;
    
  } catch (error) {
    logToFile(`❌ Error creating task pages: ${error.message}`);
    if (error.body) {
      logToFile(`Error details: ${JSON.stringify(error.body)}`);
    }
    throw error;
  }
}

// NOTE: The duplicate command handler for /extract-tasks was removed from here
// This was causing the issue with tasks not being properly created
// The main handler is already defined at line ~985



// The duplicate extract-tasks command registration code below has been removed
// to prevent conflicts with the registration in the ready event handler

// Export the client for testing
module.exports = { client, notion, findProjectByQuery, getNotionPageUrl, fetchProjectDeadlines, generateIssueReport, fetchProjectAssignments };

// Add this function after the findProjectByQuery function

// Function to fetch project deadlines from Notion
async function fetchProjectDeadlines(prefix = null, projectCode = null) {
  try {
    if (!notion) {
      logToFile('Notion client not initialized');
      return { success: false, error: 'Notion integration is not configured' };
    }
    
    // Get database ID from environment variable or global variable
    const databaseId = process.env.NOTION_DB_ID || process.env.NOTION_DATABASE_ID || DB;
    
    if (!databaseId) {
      logToFile('ERROR: Notion database ID is undefined. Check your environment variables.');
      return { success: false, error: 'Notion database ID is undefined' };
    }
    
    logToFile(`Fetching project deadlines for ${projectCode || prefix || 'all projects'}`);
    
    // Create filter based on input
    let filter = {};
    
    if (projectCode) {
      // If a specific project code is provided, filter by that
      filter = {
        property: "Project name",
        title: {
          contains: projectCode
        }
      };
      logToFile(`Filtering by project code: ${projectCode}`);
    } else if (prefix) {
      // If a prefix is provided (CL, IB, BC), filter by that
      filter = {
        property: "Project name",
        title: {
          contains: prefix
        }
      };
      logToFile(`Filtering by prefix: ${prefix}`);
    }

    // Query the database for projects
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      sorts: [
        {
          property: "Upload Date",
          direction: "ascending"
        }
      ],
      page_size: 100
    });

    const results = response.results;
    logToFile(`Found ${results.length} projects`);

    // Extract relevant information from each project
    const projects = [];
    
    for (const page of results) {
      try {
        // Extract project code from title
        const projectName = page.properties["Project name"]?.title?.[0]?.plain_text || "Unknown";
        const codeMatch = projectName.match(/(CL|IB|BC)\d{2}/i);
        const code = codeMatch ? codeMatch[0].toUpperCase() : projectName;
        
        // Skip if we can't extract a code and no specific code was requested
        if (!code && !projectCode) continue;
        
        // Get various date properties
        const mainDate = page.properties["Upload Date"]?.date?.start || null;
        const currentStageDate = page.properties["Date for current stage"]?.date?.start || null;
        
        // Format dates if they exist
        const formattedMainDate = mainDate ? new Date(mainDate).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric'
        }) : 'Not set';
        
        const formattedStageDate = currentStageDate ? new Date(currentStageDate).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric'
        }) : 'Not set';
        
        // Get status
        let status = 'Not set';
        if (page.properties.Status?.status?.name) {
          status = page.properties.Status.status.name;
        } else if (page.properties.Status?.select?.name) {
          status = page.properties.Status.select.name;
        }
        
        // Add project to the result list
        projects.push({
          code,
          name: projectName,
          mainDeadline: mainDate,
          formattedMainDeadline: formattedMainDate,
          stageDeadline: currentStageDate,
          formattedStageDeadline: formattedStageDate,
          status,
          notionUrl: getNotionPageUrl(page.id),
          pageId: page.id
        });
      } catch (projectError) {
        logToFile(`Error processing project: ${projectError.message}`);
        // Continue with next project
      }
    }
    
    // Sort projects by main deadline
    projects.sort((a, b) => {
      // If both have deadlines, sort by date
      if (a.mainDeadline && b.mainDeadline) {
        return new Date(a.mainDeadline) - new Date(b.mainDeadline);
      }
      // If only one has a deadline, it comes first
      if (a.mainDeadline) return -1;
      if (b.mainDeadline) return 1;
      // If neither has a deadline, sort by code
      return a.code.localeCompare(b.code);
    });
    
    return { success: true, projects };
    
  } catch (error) {
    logToFile(`Error fetching project deadlines: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Function to update tasks based on end-of-day messages
async function checkEndOfDayTaskUpdates() {
  try {
    logToFile(`=== Starting End-of-Day Task Update Check ===`);
    
    // Get the channel
    const channel = client.channels.cache.get(MESSAGE_BACKUP_CHANNEL_ID);
    if (!channel) {
      logToFile(`❌ Error: Channel with ID ${MESSAGE_BACKUP_CHANNEL_ID} not found!`);
      return { success: false, error: "Channel not found" };
    }
    
    logToFile(`Found channel #${channel.name} (${channel.id})`);
    
    // Calculate today's time range in the configured timezone
    const now = new Date();
    const today = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
    
    // Set the time range (16:00 to 20:00)
    const startTime = new Date(today);
    startTime.setHours(16, 0, 0, 0);
    
    const endTime = new Date(today);
    endTime.setHours(20, 0, 0, 0);
    
    // Convert to UTC for comparison with Discord timestamps
    const utcStartTime = new Date(startTime.toLocaleString('en-US', { timeZone: 'UTC' }));
    const utcEndTime = new Date(endTime.toLocaleString('en-US', { timeZone: 'UTC' }));
    
    // If current time is before 16:00, skip the check
    if (now < utcStartTime) {
      logToFile(`Current time is before 16:00 ${TZ}, skipping end-of-day task check`);
      return { success: true, skipped: true };
    }
    
    logToFile(`Collecting messages between ${utcStartTime.toISOString()} and ${utcEndTime.toISOString()} (16:00-20:00 in ${TZ})`);
    
    try {
      // Fetch messages from the channel
      const messages = await channel.messages.fetch({ limit: 100 });
      
      // Filter messages within the time range
      const recentMessages = messages.filter(msg => {
        const msgTime = new Date(msg.createdAt);
        return msgTime >= utcStartTime && msgTime <= utcEndTime;
      });
      
      logToFile(`Found ${recentMessages.size} messages sent between 16:00-20:00`);
      
      if (recentMessages.size === 0) {
        logToFile(`No messages found in the specified time range.`);
        return { success: true, messageCount: 0, updatedTasks: 0 };
      }
      
      // Analyze messages to find completed tasks
      // First, extract tasks by author
      const tasksByAuthor = extractTasksByAuthor(recentMessages);
      
      // Need to query the Notion database to get all tasks for today
      if (!notion) {
        logToFile(`❌ Notion client not initialized`);
        return { success: false, error: "Notion not initialized" };
      }
      
      // Use the specific database ID for tasks
      const TASKS_DB_ID = '1e787c20070a80319db0f8a08f255c3c';
      
      // Get today's date in ISO format
      const todayISO = moment().tz(TZ).format('YYYY-MM-DD');
      
      // Query Notion for tasks created today
      const taskResponse = await notion.databases.query({
        database_id: TASKS_DB_ID,
        filter: {
          property: "Upload Date",
          date: {
            equals: todayISO
          }
        }
      });
      
      logToFile(`Found ${taskResponse.results.length} tasks created today in Notion`);
      
      // Check for task completion phrases in messages
      const completionPhrases = [
        "done", "completed", "finished", "fixed", "resolved", "complete",
        "did it", "closed", "done with", "accomplished"
      ];
      
      let tasksUpdated = 0;
      
      // For each task in Notion
      for (const taskPage of taskResponse.results) {
        // Get task title and assignee
        const taskTitle = taskPage.properties.title?.title?.[0]?.text?.content || 
                         taskPage.properties.Title?.title?.[0]?.text?.content || "";
        
        if (!taskTitle) continue;
        
        // Get current progress status
        const currentProgress = taskPage.properties.Progress?.select?.name || "";
        
        // Skip if already marked as Done
        if (currentProgress === "Done") continue;
        
        // Check if any message indicates this task is complete
        const isCompleted = [...recentMessages.values()].some(msg => {
          const content = msg.content.toLowerCase();
          
          // Check if the message contains the task name or a close match
          const containsTaskReference = content.includes(taskTitle.toLowerCase()) || 
                                       // Check for partial matches with at least 5 characters
                                       (taskTitle.length > 5 && content.includes(taskTitle.substring(0, Math.floor(taskTitle.length * 0.7)).toLowerCase()));
          
          if (!containsTaskReference) return false;
          
          // Check if any completion phrase is in the message
          return completionPhrases.some(phrase => content.includes(phrase.toLowerCase()));
        });
        
        if (isCompleted) {
          // Update the task status to Done
          try {
            await notion.pages.update({
              page_id: taskPage.id,
              properties: {
                Progress: {
                  select: {
                    name: "Done"
                  }
                }
              }
            });
            
            logToFile(`✅ Updated task "${taskTitle}" to Done`);
            tasksUpdated++;
          } catch (updateError) {
            logToFile(`❌ Error updating task "${taskTitle}": ${updateError.message}`);
          }
        }
      }
      
      // Check stored tasks from local record
      const storedTasks = loadTasks();
      for (const task of storedTasks) {
        if (task.completed) continue;

        const isDone = [...recentMessages.values()].some(msg => {
          const content = msg.content.toLowerCase();
          const refMatch = content.includes(task.text?.toLowerCase());
          if (!refMatch) return false;
          return completionPhrases.some(p => content.includes(p));
        });

        let summaryMsg = null;
        try {
          const taskChannel = client.channels.cache.get(task.channelId || channel.id);
          if (taskChannel) {
            summaryMsg = await taskChannel.messages.fetch(task.summaryMessageId);
            await summaryMsg.react(isDone ? '✔️' : '❌');
          }
        } catch (reactErr) {
          logToFile(`⚠️ Unable to react to summary message ${task.summaryMessageId}: ${reactErr.message}`);
        }

        if (isDone) {
          addCreds(task.authorId, task.points || 0);
          task.completed = true;
          tasksUpdated++;
        }
      }
      saveTasks(storedTasks);

      logToFile(`✅ End-of-day task check completed: Updated ${tasksUpdated} tasks to Done`);
      
      return {
        success: true,
        messageCount: recentMessages.size,
        updatedTasks: tasksUpdated
      };
      
    } catch (fetchError) {
      logToFile(`❌ Error fetching messages: ${fetchError.message}`);
      throw fetchError;
    }
  } catch (error) {
    logToFile(`❌ Error in checkEndOfDayTaskUpdates: ${error.message}`);
    console.error('Error checking end-of-day task updates:', error);
    return { success: false, error: error.message };
  }
}

// Collect recent messages from all text channels within the given timeframe
async function collectMessagesForReport(timeframe) {
  const days = timeframe === 'month' ? 30 : 7;
  const start = Date.now() - days * 24 * 60 * 60 * 1000;
  const messages = [];
  const MAX_MESSAGES = 1000; // cap per channel

  for (const channel of client.channels.cache.values()) {
    if (!channel.isTextBased() || channel.isThread()) continue;
    let lastId;
    let fetchedCount = 0;
    try {
      while (fetchedCount < MAX_MESSAGES) {
        const options = { limit: Math.min(100, MAX_MESSAGES - fetchedCount) };
        if (lastId) options.before = lastId;
        const fetched = await channel.messages.fetch(options);
        if (fetched.size === 0) break;
        for (const msg of fetched.values()) {
          if (msg.createdTimestamp < start) {
            fetchedCount = MAX_MESSAGES;
            break;
          }
          if (msg.content) {
            const ts = new Date(msg.createdTimestamp).toISOString();
            messages.push(`[${channel.name}] ${ts} ${msg.author.username}: ${msg.content}`);
          }
        }
        fetchedCount += fetched.size;
        const last = fetched.last();
        if (!last || last.createdTimestamp < start) break;
        lastId = last.id;
        if (fetched.size < 100) break;
      }
    } catch (err) {
      logToFile(`Error fetching messages from ${channel.id}: ${err.message}`);
    }
  }
  return messages;
}

// Cached Frame.io account ID for reuse
let cachedFrameioAccountId = null;

// Helper to look up the Frame.io account ID using the API
async function resolveFrameioAccountId() {
  if (cachedFrameioAccountId) return cachedFrameioAccountId;
  if (!process.env.FRAMEIO_TOKEN) return null;
  try {
    const resp = await axiosGetWithRetry(
      'https://api.frame.io/v2/me',
      { Authorization: `Bearer ${process.env.FRAMEIO_TOKEN}` }
    );
    const accountId = resp.data.account_id;
    if (accountId) {
      cachedFrameioAccountId = accountId;
      return accountId;
    }
    logToFile('Frame.io API response did not contain account_id');
  } catch (err) {
    const msg = frameioErrorMessage(err, 'Fetching Frame.io account ID');
    logToFile(msg);
  }
  return null;
}

// Cache for asset lookups when building folder paths
const frameioAssetCache = {};

// Fetch details for a single asset with caching
async function getFrameioAsset(assetId, headers) {
  if (frameioAssetCache[assetId]) return frameioAssetCache[assetId];
  try {
    const resp = await axiosGetWithRetry(
      `https://api.frame.io/v2/assets/${assetId}`,
      headers
    );
    frameioAssetCache[assetId] = resp.data;
    return resp.data;
  } catch (err) {
    throw new Error(frameioErrorMessage(err, `Frame.io asset ${assetId}`));
  }
}

// Build the full folder path for an asset
async function buildFrameioPath(assetId, rootId, headers) {
  const parts = [];
  let current = assetId;
  while (current && current !== rootId) {
    const asset = await getFrameioAsset(current, headers);
    if (current !== assetId && (asset.type === 'folder' || asset.type === 'version_stack' || asset.type === 'file')) {
      parts.push(asset.name);
    }
    current = asset.parent_id;
  }
  return parts.length ? '/' + parts.reverse().join('/') : '/';
}

// Recursively collect comments from a Frame.io project, limited to recent files
async function collectFrameioComments(assetId, since, headers, comments, rootId) {
  let resp;
  try {
    resp = await axiosGetWithRetry(
      `https://api.frame.io/v2/assets/${assetId}/children`,
      headers
    );
  } catch (err) {
    throw new Error(frameioErrorMessage(err, `Frame.io asset ${assetId}`));
  }
  for (const asset of resp.data) {
    if (asset.type === 'file') {
      const updated = Date.parse(asset.updated_at);
      if (!Number.isNaN(updated) && updated < since) continue;
      if (asset.comment_count > 0) {
        let cr;
        try {
          cr = await axiosGetWithRetry(
            `https://api.frame.io/v2/assets/${asset.id}/comments`,
            headers
          );
        } catch (err) {
          throw new Error(frameioErrorMessage(err, `Comments for asset ${asset.id}`));
        }
        const folder = await buildFrameioPath(asset.id, rootId, headers);
        for (const c of cr.data) {
          const created = Date.parse(c.created_at);
          if (!Number.isNaN(created) && created >= since) {
            comments.push(`[${folder}${asset.name}] ${c.text}`);
            if (comments.length >= 1000) return;
          }
        }
      }
    } else if (asset.type === 'folder' || asset.type === 'version_stack') {
      await collectFrameioComments(asset.id, since, headers, comments, rootId);
      if (comments.length >= 1000) return;
    }
  }
}

// Fetch comments from Frame.io if credentials are provided
async function fetchFrameioComments(timeframe, options = {}) {
  const { throwErrors = false } = options;
  if (!process.env.FRAMEIO_TOKEN) {
    const err = new Error('FRAMEIO_TOKEN not configured');
    if (throwErrors) throw err; else { logToFile(err.message); return []; }
  }
  const days = timeframe === 'month' ? 30 : 7;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const headers = { Authorization: `Bearer ${process.env.FRAMEIO_TOKEN}` };

  // Prefer crawling a specific project if a root asset ID is provided
  const rootEnv = process.env.FRAMEIO_ROOT_ASSET_ID;
  if (rootEnv) {
    try {
      const comments = [];
      const roots = rootEnv.split(',').map(r => r.trim()).filter(Boolean);
      for (const r of roots) {
        await collectFrameioComments(r, since, headers, comments, r);
        if (comments.length >= 1000) break;
      }
      return comments;
    } catch (err) {
      const msg = frameioErrorMessage(err, 'Fetching Frame.io comments');
      logToFile(msg);
      if (throwErrors) throw new Error(msg); else return [];
    }
  }

  // Fallback to account-wide comments using the account ID
  let accountId = process.env.FRAMEIO_ACCOUNT_ID;
  if (!accountId) {
    accountId = await resolveFrameioAccountId();
    if (!accountId) {
      logToFile('Could not determine Frame.io account ID');
      if (throwErrors) throw new Error('Could not determine Frame.io account ID');
      return [];
    }
  }
  try {
    const url = `https://api.frame.io/v2/accounts/${accountId}/comments`;
    const resp = await axiosGetWithRetry(url, headers);
    const comments = [];
    for (const c of resp.data) {
      if (new Date(c.created_at).getTime() < since) continue;
      let fileName = c.asset?.name;
      if (!fileName && c.asset_id) {
        try {
          const asset = await axiosGetWithRetry(
            `https://api.frame.io/v2/assets/${c.asset_id}`,
            headers
          );
          fileName = asset.data.name;
        } catch (err) {
          logToFile(frameioErrorMessage(err, `Fetching asset ${c.asset_id}`));
        }
      }
      comments.push(`[${fileName || 'Unknown'}] ${c.text}`);
      if (comments.length >= 1000) break;
    }
    return comments;
  } catch (err) {
    const msg = frameioErrorMessage(err, 'Fetching Frame.io comments');
    logToFile(msg);
    if (throwErrors) throw new Error(msg); else return [];
  }
}

// Generate a detailed changelog text for a single project
async function generateProjectChangelog(code) {
  try {
    const project = await findProjectByQuery(code);
    if (!project) return '';
    const page = project.page;
    let statusChanges = [];
    let currentStatus = 'Unknown';
    if (page.properties.Status?.status?.name) {
      currentStatus = page.properties.Status.status.name;
      statusChanges.push({ status: currentStatus, date: new Date(page.last_edited_time) });
    }

    const response = await notion.databases.query({
      database_id: CHANGELOG_DB,
      filter: { property: 'Title', title: { contains: code } },
      sorts: [{ property: 'Changed At', direction: 'ascending' }],
      page_size: 100
    });

    for (const related of response.results) {
      if (related.id === page.id) continue;
      let pageStatus = null;
      const props = ['New Status', 'Status', 'status', 'Stage', 'Pipeline Stage'];
      for (const prop of props) {
        const val = related.properties[prop];
        if (val && (val.status?.name || val.select?.name)) {
          pageStatus = val.status?.name || val.select?.name;
          break;
        }
      }
      if (pageStatus) {
        const dateVal = related.properties['Changed At']?.date?.start || related.created_time;
        statusChanges.push({ status: pageStatus, date: new Date(dateVal) });
      }
    }

    if (statusChanges.length === 0) {
      statusChanges.push({ status: 'Created', date: new Date(page.created_time) });
      if (page.last_edited_time !== page.created_time) {
        statusChanges.push({ status: currentStatus, date: new Date(page.last_edited_time) });
      }
    }

    statusChanges.sort((a, b) => a.date - b.date);
    const unique = [];
    let last = null;
    for (const ch of statusChanges) {
      if (ch.status !== last) { unique.push(ch); last = ch.status; }
    }
    statusChanges = unique;
    for (let i = 1; i < statusChanges.length; i++) {
      const diff = Math.round((statusChanges[i].date - statusChanges[i-1].date) / (1000 * 60 * 60 * 24));
      statusChanges[i].daysSincePrevious = diff;
    }

    const projectName = page.properties['Title']?.title?.[0]?.plain_text ||
                        page.properties['Project name']?.title?.[0]?.plain_text || code;
    const lines = [`Status history for ${code} - ${projectName}`, '', `Current Status: ${currentStatus}`];
    statusChanges.forEach((change, idx) => {
      const dateStr = change.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const days = change.daysSincePrevious ? ` (${change.daysSincePrevious} day${change.daysSincePrevious !== 1 ? 's' : ''})` : '';
      lines.push(`${idx + 1}. ${change.status}`);
      lines.push(`📅 ${dateStr}${days}`);
    });

    if (statusChanges.length >= 2) {
      lines.push('⏳ Complete Timeline');
      let timeline = '';
      statusChanges.forEach((change, i) => {
        const dateStr = change.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const days = change.daysSincePrevious ? ` (${change.daysSincePrevious} day${change.daysSincePrevious !== 1 ? 's' : ''})` : '';
        const bar = i > 0 ? `↓ ─────${days}\n` : '';
        timeline += `${bar}${change.status},\n- ${dateStr}\n`;
      });
      lines.push(timeline.trim());

      const totalDays = Math.round((statusChanges[statusChanges.length - 1].date - statusChanges[0].date) / (1000 * 60 * 60 * 24));
      lines.push("⏱️ Total Time in Pipeline");
      lines.push(`${totalDays} days`);

      if (statusChanges.length > 2) {
        const totalTracked = statusChanges.reduce((sum, ch) => sum + (ch.daysSincePrevious || 0), 0);
        const avg = (totalTracked / (statusChanges.length - 1)).toFixed(1);
        lines.push('📊 Average Time Per Stage');
        lines.push(`${avg} days`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    logToFile(`Error generating changelog for ${code}: ${err.message}`);
    return '';
  }
}

// Fetch recent changelog entries for projects in the given timeframe
async function fetchChangelogSummary(timeframe) {
  if (!notion || !CHANGELOG_DB) return '';
  const days = timeframe === 'month' ? 30 : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const resp = await notion.databases.query({
      database_id: CHANGELOG_DB,
      filter: { property: 'Changed At', date: { on_or_after: since } },
      sorts: [{ property: 'Changed At', direction: 'descending' }],
      page_size: 50
    });

    const codes = new Set();
    resp.results.forEach(p => {
      const title = p.properties.Title?.title?.[0]?.plain_text || '';
      const match = title.match(/(CL|IB|BC)\d{2}/i);
      if (match) codes.add(match[0].toUpperCase());
    });

    const summaries = [];
    for (const code of codes) {
      const text = await generateProjectChangelog(code);
      if (text) summaries.push(`Changelog for ${code}\n${text}`);
    }
    return summaries.join('\n\n');
  } catch (err) {
    logToFile(`Error fetching changelog: ${err.message}`);
    return '';
  }
}

// Fetch projects changed recently and list assignees
async function fetchProjectAssignments(timeframe) {
  if (!notion || !DB) return [];
  const days = timeframe === 'month' ? 30 : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const resp = await notion.databases.query({
      database_id: DB,
      filter: {
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: since }
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      page_size: 50
    });

    return resp.results.map(p => {
      const name = p.properties['Project name']?.title?.[0]?.plain_text || 'Untitled';
      const codeMatch = name.match(/(CL|IB|BC)\d{2}/i);
      const code = codeMatch ? codeMatch[0].toUpperCase() : name;
      const owner = p.properties['Project Owner']?.people?.map(u => u.name).join(', ') ||
                    p.properties['Project Owner']?.select?.name || 'Unassigned';
      const editor = p.properties['Editor']?.people?.map(u => u.name).join(', ') ||
                     p.properties['Editor']?.multi_select?.map(o => o.name).join(', ') || 'None';
      const writer = p.properties['Writer']?.people?.map(u => u.name).join(', ') ||
                     p.properties['Writer']?.multi_select?.map(o => o.name).join(', ') || 'None';
      const status = p.properties.Status?.status?.name || p.properties.Status?.select?.name || 'Unknown';

      return `${code} - ${status} | Owner: ${owner} | Editor: ${editor} | Writer: ${writer}`;
    });
  } catch (err) {
    logToFile(`Error fetching project assignments: ${err.message}`);
    return [];
  }
}

// Compile messages and comments into text files
async function generateIssueReport(timeframe = 'week') {
  try {
    const msgs = await collectMessagesForReport(timeframe);
    const frame = await fetchFrameioComments(timeframe);
    const changelog = await fetchChangelogSummary(timeframe);
    const assignments = await fetchProjectAssignments(timeframe);

    const dir = path.join(__dirname, 'issue-reports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const msgFile = path.join(dir, `discord-${timestamp}.txt`);
    const frameFile = path.join(dir, `frameio-${timestamp}.txt`);
    const changelogFile = path.join(dir, `changelog-${timestamp}.txt`);
    const assignFile = path.join(dir, `assignments-${timestamp}.txt`);

    fs.writeFileSync(msgFile, msgs.join('\n'), 'utf8');
    fs.writeFileSync(frameFile, frame.join('\n'), 'utf8');
    fs.writeFileSync(changelogFile, changelog, 'utf8');
    fs.writeFileSync(assignFile, assignments.join('\n'), 'utf8');

    return { msgFile, frameFile, changelogFile, assignFile };
  } catch (err) {
    logToFile(`Error generating issue report: ${err.message}`);
    return null;
  }
}

// Export basic project data to a file
function exportProjectData(data, format) {
  const dir = path.join(__dirname, 'exports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const code = data.code || 'project';
  let filePath;

  if (format === 'json') {
    filePath = path.join(dir, `${code}-${timestamp}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } else if (format === 'csv') {
    filePath = path.join(dir, `${code}-${timestamp}.csv`);
    const keys = Object.keys(data);
    const csv = keys.join(',') + '\n' +
      keys.map(k => '"' + String(data[k] ?? '').replace(/"/g, '""') + '"').join(',');
    fs.writeFileSync(filePath, csv, 'utf8');
  } else {
    filePath = path.join(dir, `${code}-${timestamp}.txt`);
    const text = Object.entries(data).map(([k, v]) => `${k}: ${v}`).join('\n');
    fs.writeFileSync(filePath, text, 'utf8');
  }

  return filePath;
}

// Add this near the top of the file with other requires
// path is already required at the top of the file

// Add this after other client events but before client.login
// Real-time message collection for knowledge assistant
const BACKUPS_DIR = path.join(__dirname, 'backups');
const RECENT_MESSAGES_LIMIT = 1000; // Keep the most recent messages in memory
const recentMessages = [];

// Check if backups directory exists
if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  console.log(`Created backups directory: ${BACKUPS_DIR}`);
}

// Function to save recent messages to file periodically
function saveRecentMessages() {
  try {
    // Only save if we have messages
    if (recentMessages.length === 0) return;
    
    // Group messages by guild
    const messagesByGuild = {};
    recentMessages.forEach(msg => {
      if (!messagesByGuild[msg.guildId]) {
        messagesByGuild[msg.guildId] = {
          guildId: msg.guildId,
          guildName: msg.guildName,
          backupDate: new Date().toISOString(),
          messages: []
        };
      }
      messagesByGuild[msg.guildId].messages.push(msg);
    });
    
    // Save each guild's messages to a file
    Object.values(messagesByGuild).forEach(guildData => {
      const now = new Date();
      const dateString = now.toISOString().split('T')[0]; // YYYY-MM-DD
      const filename = `${guildData.guildName.replace(/[^a-z0-9]/gi, '_')}-realtime-${dateString}.json`;
      const filePath = path.join(BACKUPS_DIR, filename);
      
      guildData.messageCount = guildData.messages.length;
      fs.writeFileSync(filePath, JSON.stringify(guildData, null, 2));
      console.log(`Saved ${guildData.messages.length} recent messages from ${guildData.guildName}`);
    });
    
    // Clear the array after saving
    recentMessages.length = 0;
  } catch (error) {
    console.error(`Error saving recent messages: ${error.message}`);
  }
}

// Save messages every hour
setInterval(saveRecentMessages, 60 * 60 * 1000);

// Save messages when the bot shuts down
process.on('SIGINT', () => {
  console.log('Saving recent messages before shutdown...');
  saveRecentMessages();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Saving recent messages before shutdown...');
  saveRecentMessages();
  process.exit(0);
});

// Collect messages in real-time and handle image edit replies
client.on('messageCreate', async message => {
  // Skip bot messages
  if (message.author.bot) return;

  // If replying to a bot-generated image, treat as an edit prompt
  if (message.reference?.messageId) {
    const prevId = imageResponseMap.get(message.reference.messageId);
    if (prevId && openai) {
      try {
        const stylePrompt = `${RED_MONOLITH_STYLE}\n${message.content}`;
        const input = [{ role: 'user', content: [{ type: 'input_text', text: stylePrompt }] }];
        const params = {
          model: 'gpt-4o',
          input,
          tools: [{ type: 'image_generation', partial_images: 2, size: '1536x1024', quality: 'high' }],
          previous_response_id: prevId,
          stream: true
        };
        const stream = await openai.responses.create(params);
        let finalBuffer = null;
        let responseId = null;
        for await (const event of stream) {
          if (event.result) {
            responseId = event.id;
            finalBuffer = Buffer.from(event.result, 'base64');
          }
        }

        if (!finalBuffer) {
          logToFile('Edit stream produced no result. Using images.generate fallback');
          try {
            const gen = await openai.images.generate({
              model: 'dall-e-3',
              prompt: stylePrompt,
              n: 1,
              size: '1024x1024',
              response_format: 'b64_json'
            });
            const imgB64 = gen.data?.[0]?.b64_json;
            if (imgB64) {
              finalBuffer = Buffer.from(imgB64, 'base64');
              responseId = gen.created?.toString();
            }
          } catch (genErr) {
            logToFile(`Fallback edit generation failed: ${genErr.message}`);
          }
        }

        if (!finalBuffer) {
          await message.reply('❌ Image generation failed.');
        } else {
          const attachment = new AttachmentBuilder(finalBuffer, { name: 'image.png' });
          const replyMsg = await message.reply({ content: `🖼️ Edited image (Response ID: ${responseId})`, files: [attachment] });
          imageResponseMap.set(replyMsg.id, responseId);
          lastImageResponses.set(message.author.id, responseId);
        }
      } catch (error) {
        logToFile(`Error editing image: ${error.message}`);
        await message.reply(`❌ ${error.message}`);
      }
      return; // Do not store the edit prompt in recentMessages
    }
  }

  // Skip messages without content
  if (!message.content.trim()) return;
  
  // Store important message information
  const storedMessage = {
    id: message.id,
    content: message.content,
    author: {
      id: message.author.id,
      username: message.author.username,
      tag: message.author.tag
    },
    channelId: message.channel.id,
    channelName: message.channel.name,
    guildId: message.guild?.id,
    guildName: message.guild?.name,
    timestamp: message.createdAt.toISOString(),
    attachments: Array.from(message.attachments.values()).map(a => a.url)
  };
  
  // Add to recent messages array (prepend)
  recentMessages.unshift(storedMessage);

  // Persist message to the simple database
  logMessageToDB(storedMessage);
  
  // Limit the array size
  if (recentMessages.length > RECENT_MESSAGES_LIMIT) {
    recentMessages.pop();
  }
});

// Update the Knowledge Assistant to use real-time messages
// This code should go in knowledge-assistant.js, but for demonstration:

/* 
// Add this function to knowledge-assistant.js
function loadRecentMessages() {
  try {
    const recentMessagesFromBot = global.recentMessages || [];
    return recentMessagesFromBot;
  } catch (error) {
    logToFile(`Error loading recent messages: ${error.message}`);
    return [];
  }
}

// Then modify answerQuestion to combine both recent and backed up messages
*/

// Expose the recent messages array globally for the knowledge assistant
global.recentMessages = recentMessages;

// Start email forwarding server if channel ID is provided
if (EMAIL_CHANNEL_ID) {
  initEmailForwarder(app, client, EMAIL_CHANNEL_ID);
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Email forwarder listening on port ${PORT}`);
    logToFile(`Email forwarder listening on port ${PORT}`);
  });
}

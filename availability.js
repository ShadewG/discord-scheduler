/**
 * Availability Module
 * Tracks team member availability and working hours
 */

// Timezone for all calculations (Berlin)
const TZ = 'Europe/Berlin';

// Staff availability module for showing team working hours
const moment = require('moment-timezone');
const { fetchActiveProjectsForUser, fetchActiveTasksForUser } = require('./notion_utils'); // Import Notion utility functions
const { OpenAI } = require('openai'); // Import OpenAI
const { logToFile } = require('./log_utils');

// Configure OpenAI client
let openai = null;
try {
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    console.log('[Availability] OpenAI client initialized successfully');
  } else {
    console.log('[Availability] ⚠️ OPENAI_API_KEY not found, AI assessment will be unavailable.');
  }
} catch (error) {
  console.log(`[Availability] ❌ Error initializing OpenAI client: ${error.message}`);
}

// Staff availability data - name, timezone, and working hours (24-hour format)
const STAFF_AVAILABILITY = [
  {
    name: "Armin",
    discordUserId: "1032968395670880256", // Added based on previous user input
    notionProjectOwnerName: "Armin", // Assuming same name for Notion
    notionTaskAssigneeName: "Armin", // Assuming same name for Notion
    workHours: [
      { day: "Mon", start: "9:00", end: "17:30" },
      { day: "Tue", start: "9:00", end: "17:30" },
      { day: "Wed", start: "9:00", end: "17:30" },
      { day: "Thu", start: "9:00", end: "17:30" },
      { day: "Fri", start: "9:00", end: "17:30" },
    ],
    timezone: "Europe/Berlin",
  },
  {
    name: "Amin",
    discordUserId: "332227757717061653",
    notionProjectOwnerName: "Amin", 
    notionTaskAssigneeName: "Amin",
    workHours: [
      { day: "Mon", start: "7:00", end: "15:30" },
      { day: "Tue", start: "7:00", end: "15:30" },
      { day: "Wed", start: "7:00", end: "15:30" },
      { day: "Thu", start: "7:00", end: "15:30" },
      { day: "Fri", start: "7:00", end: "15:30" },
    ],
    timezone: "Europe/Berlin",
  },
  {
    name: "Ayoub",
    discordUserId: "1033050881798709378", 
    notionProjectOwnerName: "Ayoub",
    notionTaskAssigneeName: "Ayoub",
    workHours: [
      { day: "Mon", start: "9:00", end: "17:30" },
      { day: "Tue", start: "9:00", end: "17:30" },
      { day: "Wed", start: "9:00", end: "17:30" },
      { day: "Thu", start: "9:00", end: "17:30" },
      { day: "Fri", start: "9:00", end: "17:30" },
    ],
    timezone: "Europe/Berlin",
  },
  {
    name: "Jokubas",
    discordUserId: "698791305840558181",
    notionProjectOwnerName: "Wise", // Jokubas is Wise for Project Owner
    notionTaskAssigneeName: "Wise", // Jokubas is Wise for Task Assignee
    workHours: [
      { day: "Mon", start: "9:00", end: "17:30" },
      { day: "Tue", start: "9:00", end: "17:30" },
      { day: "Wed", start: "9:00", end: "17:30" },
      { day: "Thu", start: "9:00", end: "17:30" },
      { day: "Fri", start: "9:00", end: "17:30" },
    ],
    timezone: "Europe/Vilnius",
  },
  {
    name: "Dominik",
    discordUserId: "186424377993068544", // Atom's ID
    notionProjectOwnerName: "Atom",   // Dominik is Atom for Project Owner
    notionTaskAssigneeName: "Dominik", // Dominik is Dominik for Task Assignee
    workHours: [
      { day: "Mon", start: "9:00", end: "17:30" },
      { day: "Tue", start: "9:00", end: "17:30" },
      { day: "Wed", start: "9:00", end: "17:30" },
      { day: "Thu", start: "9:00", end: "17:30" },
      { day: "Fri", start: "9:00", end: "17:30" },
    ],
    timezone: "Europe/Berlin",
  },
  {
    name: "Yovcho",
    discordUserId: "826463354598981643",
    notionProjectOwnerName: "Yovcho",
    notionTaskAssigneeName: "Yovcho",
    workHours: [
      { day: "Mon", start: "9:00", end: "17:30" },
      { day: "Tue", start: "9:00", end: "17:30" },
      { day: "Wed", start: "9:00", end: "17:30" },
      { day: "Thu", start: "9:00", end: "17:30" },
      { day: "Fri", start: "9:00", end: "17:30" },
    ],
    timezone: "Europe/Sofia",
  },
  {
    name: "Austin",
    discordUserId: "987596470272278569", // Suki's ID
    notionProjectOwnerName: "Suki",     // Austin is Suki for Notion
    notionTaskAssigneeName: "Suki",     // Austin is Suki for Notion
    workHours: [
      { day: "Mon", start: "14:30", end: "23:00" },
      { day: "Tue", start: "14:30", end: "23:00" },
      { day: "Wed", start: "14:30", end: "23:00" },
      { day: "Thu", start: "14:30", end: "23:00" },
      { day: "Fri", start: "14:30", end: "23:00" },
    ],
    timezone: "America/Denver", // MDT, which is UTC-6
  },
  {
    name: "Dreams", // Nicholas Rice
    discordUserId: "122104719513485314",
    notionProjectOwnerName: "Nicholas Rice", // Notion name is Nicholas Rice
    notionTaskAssigneeName: "Nicholas Rice", // Notion name is Nicholas Rice
    workHours: [
      { day: "Mon", start: "17:00", end: "23:00" }, 
      { day: "Tue", start: "17:00", end: "23:00" },
      { day: "Wed", start: "17:00", end: "23:00" },
      { day: "Thu", start: "17:00", end: "23:00" },
      { day: "Fri", start: "17:00", end: "23:00" },
    ],
    timezone: "America/New_York", // EDT, which is UTC-4
  },
];

/**
 * Get the current time in Berlin timezone
 * @returns {string} Current time in Berlin in format HH:MM
 */
function getCurrentBerlinTime() {
  return moment().tz("Europe/Berlin").format("ddd, MMM D, HH:mm");
}

/**
 * Parse time string into hours and minutes
 * @param {string} timeStr - Time string in format HH:MM
 * @returns {Object} Object with hours and minutes as numbers
 */
function parseTime(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return { hours, minutes };
}

/**
 * Check if current time is between start and end time
 * @param {string} startTime - Start time in format HH:MM
 * @param {string} endTime - End time in format HH:MM
 * @returns {boolean} True if current time is within range
 */
function isTimeInRange(startTime, endTime) {
  const now = getCurrentBerlinTime();
  
  const start = parseTime(startTime);
  const end = parseTime(endTime);
  const current = parseTime(now);
  
  // Convert all to minutes for easier comparison
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;
  const currentMinutes = current.hours * 60 + current.minutes;
  
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * Get the current day of week (1-7, where 1 is Monday)
 * @returns {number} Day of week (1-7)
 */
function getCurrentDayOfWeek() {
  const options = { timeZone: TZ };
  const berlinDate = new Date(new Date().toLocaleString('en-US', options));
  // getDay() returns 0-6 where 0 is Sunday, but we want 1-7 where 1 is Monday
  let day = berlinDate.getDay();
  return day === 0 ? 7 : day; // Convert Sunday from 0 to 7
}

/**
 * Check if staff member is currently active based on their timezone, working hours, and days off
 * @param {Object} staff - Staff member object
 * @returns {boolean} True if staff is currently active
 */
function isStaffActive(staff) {
  const now = moment().tz(staff.timezone);
  const currentDay = now.format("ddd"); // Mon, Tue, etc.
  const currentTime = now.format("HH:mm");

  const todayWorkHours = staff.workHours.find(wh => wh.day === currentDay);

  if (!todayWorkHours) {
    return false; // Not scheduled to work today
  }

  return currentTime >= todayWorkHours.start && currentTime <= todayWorkHours.end;
}

/**
 * Get formatted time left in shift for an active staff member
 * @param {Object} staff - Staff member object
 * @returns {string} Formatted time left in shift
 */
function getTimeLeftInShift(staff) {
  if (!isStaffActive(staff)) {
    return "Not currently working";
  }

  const now = moment().tz(staff.timezone);
  const currentDay = now.format("ddd");
  const todayWorkHours = staff.workHours.find(wh => wh.day === currentDay);

  const endTime = moment.tz(`${now.format("YYYY-MM-DD")} ${todayWorkHours.end}`, staff.timezone);
  const diff = moment.duration(endTime.diff(now));

  const hours = Math.floor(diff.asHours());
  const minutes = diff.minutes();

  if (hours < 0 || minutes < 0) return "Shift ended"; // Should not happen if isStaffActive is true
  return `${hours}h ${minutes}m left`;
}

/**
 * Create a visual progress bar showing current position in work hours
 * @param {Object} staff - Staff member object
 * @returns {string} ASCII progress bar
 */
function createTimeProgressBar(staff) {
  const localTime = moment().tz(staff.timezone);
  const dayOfWeek = localTime.day();
  const hour = localTime.hour();
  const min = localTime.minute();
  
  // Not a working day
  if (staff.workHours.length === 0) {
    return `${staff.timezone}: No schedule defined`;
  }
  
  // Get local time formatted
  const timeStr = localTime.format("HH:mm");
  
  // Calculate progress through shift
  const totalMinutesInShift = (staff.workHours[staff.workHours.length - 1].end - staff.workHours[0].start) * 60;
  const minutesSinceStart = (hour - staff.workHours[0].start) * 60 + min;
  
  // Handle times outside of working hours
  if (hour < staff.workHours[0].start) {
    return `${staff.timezone}: ${timeStr} (Starts at ${staff.workHours[0].start}:00)`;
  }
  
  if (hour >= staff.workHours[staff.workHours.length - 1].end) {
    return `${staff.timezone}: ${timeStr} (Ended at ${staff.workHours[staff.workHours.length - 1].end}:00)`;
  }
  
  // Create progress bar
  const barLength = 20;
  const progress = minutesSinceStart / totalMinutesInShift;
  const filledBars = Math.round(progress * barLength);
  const emptyBars = barLength - filledBars;
  
  const progressBar = '▓'.repeat(filledBars) + '░'.repeat(emptyBars);
  const percentage = Math.round(progress * 100);
  
  return `${staff.timezone}: ${timeStr} [${progressBar}] ${percentage}%`;
}

// Format working hours for display 
function formatWorkingHours(staff) {
  const today = moment().tz(staff.timezone).format("ddd");
  const workHoursToday = staff.workHours.find(wh => wh.day === today);
  
  if (workHoursToday) {
    return `${today} ${workHoursToday.start}-${workHoursToday.end} (${staff.timezone.split('/')[1].replace('_',' ')})`;
  }
  // Find the general pattern if today is not a workday (e.g., weekend)
  if (staff.workHours.length > 0) {
    const typicalDay = staff.workHours[0]; // Assume first entry is typical
    const days = staff.workHours.map(wh => wh.day).join('-');
    return `${days} ${typicalDay.start}-${typicalDay.end} (${staff.timezone.split('/')[1].replace('_',' ')})`;
  }
  return "No schedule defined";
}

/**
 * Fetches Notion workload details (projects and tasks) for a staff member.
 * @param {Object} staff - Staff member object from STAFF_AVAILABILITY.
 * @returns {Promise<Object>} An object with projects and tasks arrays.
 */
async function getStaffWorkloadDetails(staff) {
  logToFile(`[Availability/getStaffWorkloadDetails] Processing staff: ${staff.name}, Discord ID: ${staff.discordUserId}`);
  logToFile(`[Availability/getStaffWorkloadDetails] Notion Project Owner Name: '${staff.notionProjectOwnerName}', Notion Task Assignee Name: '${staff.notionTaskAssigneeName}'`);

  let projects = [];
  let tasks = [];

  try {
    if (staff.notionProjectOwnerName) {
      logToFile(`[Availability/getStaffWorkloadDetails] Fetching projects for ${staff.name} using owner name: '${staff.notionProjectOwnerName}'`);
      // Pass the whole staff object to fetchActiveProjectsForUser
      projects = await fetchActiveProjectsForUser(staff);
      logToFile(`[Availability/getStaffWorkloadDetails] Fetched ${projects.length} projects for ${staff.name}`);
    } else {
      logToFile(`[Availability/getStaffWorkloadDetails] Skipping project fetch for ${staff.name}: notionProjectOwnerName is missing.`);
    }

    if (staff.notionTaskAssigneeName) {
      logToFile(`[Availability/getStaffWorkloadDetails] Fetching tasks for ${staff.name} using assignee name: '${staff.notionTaskAssigneeName}'`);
      // Pass the whole staff object to fetchActiveTasksForUser
      tasks = await fetchActiveTasksForUser(staff);
      logToFile(`[Availability/getStaffWorkloadDetails] Fetched ${tasks.length} tasks for ${staff.name}`);
    } else {
      logToFile(`[Availability/getStaffWorkloadDetails] Skipping task fetch for ${staff.name}: notionTaskAssigneeName is missing.`);
    }
  } catch (error) {
    logToFile(`[Availability/getStaffWorkloadDetails] Error fetching Notion data for ${staff.name}: ${error.message}\nStack: ${error.stack}`);
    // Return empty arrays or rethrow, depending on desired error handling
    projects = []; 
    tasks = [];
  }
  
  return { projects, tasks };
}

async function getAIAvailabilityAssessment(staffName, projects, tasks) {
  if (!openai) {
    logToFile('[Availability/getAIAssessment] OpenAI client not available. Skipping AI assessment.');
    return "AI Assessment N/A (OpenAI not configured)";
  }
  if (projects.length === 0 && tasks.length === 0) {
    return "Highly Available - No projects or tasks listed.";
  }

  const projectList = projects.map(p => `- ${p.name}`).join('\n');
  const taskSummary = `Total active tasks: ${tasks.length}`;

  const prompt = `
    User ${staffName} is currently working.
    Active Projects:
    ${projectList || "- None"}
    Active Tasks Summary: ${taskSummary}

    Based on this, assess their current availability for a new high-priority project. 
    Consider both the number of projects and tasks. 
    Provide a brief availability status (e.g., Highly Available, Moderately Available, Limited Availability, Potentially Overloaded) and a very short reasoning (1 sentence max).
    Example: "Moderately Available - Handling a few projects and tasks."
    Example: "Highly Available - Light current workload."
    Example: "Limited Availability - Assigned to multiple projects and many tasks."
  `;

  try {
    logToFile(`[Availability/getAIAssessment] Getting AI assessment for ${staffName} with ${projects.length} projects and ${tasks.length} tasks.`);
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 60,
      temperature: 0.3,
    });
    logToFile(`[Availability/getAIAssessment] AI response for ${staffName}: ${response.choices[0].message.content.trim()}`);
    return response.choices[0].message.content.trim();
  } catch (error) {
    logToFile(`[Availability/getAIAssessment] Error getting AI assessment for ${staffName}: ${error.message}`);
    return "AI Assessment Error";
  }
}

module.exports = {
  STAFF_AVAILABILITY,
  getCurrentBerlinTime,
  isStaffActive,
  getTimeLeftInShift,
  createTimeProgressBar,
  formatWorkingHours,
  getStaffWorkloadDetails,
  getAIAvailabilityAssessment, // Export the new function
}; 
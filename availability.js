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
    discordUserId: "1032968395670880256",
    notionProjectOwnerName: "Armin",
    notionTaskAssigneeName: "Armin",
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
    notionTaskAssigneeName: "Amino",
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
    notionProjectOwnerName: "Wise", 
    notionTaskAssigneeName: "Jokubas",
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
    discordUserId: "186424377993068544",
    notionProjectOwnerName: "Atom",
    notionTaskAssigneeName: "atomboy7",
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
    discordUserId: "987596470272278569",
    notionProjectOwnerName: "Suki",
    notionTaskAssigneeName: "suki0832",
    workHours: [
      { day: "Mon", start: "14:30", end: "23:00" },
      { day: "Tue", start: "14:30", end: "23:00" },
      { day: "Wed", start: "14:30", end: "23:00" },
      { day: "Thu", start: "14:30", end: "23:00" },
      { day: "Fri", start: "14:30", end: "23:00" },
    ],
    timezone: "America/Denver",
  },
  {
    name: "Dreams",
    discordUserId: "122104719513485314",
    notionProjectOwnerName: "Nicholas Rice",
    notionTaskAssigneeName: "Dreams",
    workHours: [
      { day: "Mon", start: "17:00", end: "23:00" }, 
      { day: "Tue", start: "17:00", end: "23:00" },
      { day: "Wed", start: "17:00", end: "23:00" },
      { day: "Thu", start: "17:00", end: "23:00" },
      { day: "Fri", start: "17:00", end: "23:00" },
    ],
    timezone: "America/New_York",
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
  // Use only the HH:mm portion of the current Berlin time
  const now = moment().tz("Europe/Berlin").format("HH:mm");
  
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
function isStaffActive(staffMember) {
  const now = moment().tz(staffMember.timezone);
  const currentDayShort = now.format("ddd"); // Mon, Tue, etc.

  const todayWorkHours = staffMember.workHours.find(wh => wh.day === currentDayShort);

  if (!todayWorkHours) {
    logToFile(`[isStaffActive] ${staffMember.name} is not scheduled to work today (${currentDayShort}) in ${staffMember.timezone}.`);
    return false;
  }

  // Create moment objects for start and end times for proper comparison
  // These moments will be for the current date in the staff member's timezone
  const startTime = moment.tz(`${now.format("YYYY-MM-DD")} ${todayWorkHours.start}`, staffMember.timezone);
  const endTime = moment.tz(`${now.format("YYYY-MM-DD")} ${todayWorkHours.end}`, staffMember.timezone);

  // Check if 'now' is between startTime and endTime (inclusive of start, exclusive of end by default with isBetween)
  // To make it inclusive of end time, we check if it's same or before endTime and same or after startTime.
  const isActive = now.isSameOrAfter(startTime) && now.isSameOrBefore(endTime);
  
  logToFile(`[isStaffActive] Checking ${staffMember.name} in ${staffMember.timezone}: Now: ${now.format("HH:mm:ss")}, Day: ${currentDayShort}, Shift: ${todayWorkHours.start}-${todayWorkHours.end}. StartMoment: ${startTime.format("HH:mm:ss")}, EndMoment: ${endTime.format("HH:mm:ss")}. Active: ${isActive}`);
  
  return isActive;
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

  const projectListString = projects.map(p => `- ${p.name}`).join('\n') || "- None";
  
  let taskListString = "- None listed in Daily DB";
  if (tasks.length > 0) {
    // Assuming tasks are objects with a 'name' property and optionally 'status'
    taskListString = tasks.map(t => `- ${t.name}${t.status ? ' (Status: ' + t.status + ')' : ''}`).join('\n');
    if (taskListString.length > 600) { // Keep prompt reasonable, slightly increased limit
        taskListString = tasks.slice(0, 5).map(t => `- ${t.name}${t.status ? ' (Status: ' + t.status + ')' : ''}`).join('\n') + `\n- ... and ${tasks.length - 5} more tasks.`;
    }
  }

  const prompt = `
    Staff member: ${staffName}.
    Current active projects assigned in Notion:
    ${projectListString}

    Current active tasks assigned to ${staffName} in Notion (from a "Daily" database, status not "Done"):
    ${taskListString}
    (Total active tasks found in Daily DB: ${tasks.length})

    Based *only* on the project and task information listed above, assess ${staffName}'s current availability for a new high-priority project.
    Provide a brief availability status (e.g., Highly Available, Moderately Available, Limited Availability, Potentially Overloaded) and a very short reasoning (1 sentence max).
    Focus on the quantity and nature of current commitments. Do not invent or assume tasks or projects not listed.
    Example if tasks are listed: "Moderately Available - Handling a few projects and specific tasks."
    Example if no tasks listed but projects exist: "Moderately Available - Assigned to several projects, no specific tasks detailed here."
    Example if no projects or tasks: "Highly Available - Light current workload based on provided data."
  `;

  try {
    logToFile(`[Availability/getAIAssessment] Getting AI assessment for ${staffName}. Projects: ${projects.length}, Tasks in Daily DB: ${tasks.length}.`);
    // If taskListString became very long due to many tasks, log only a summary of it for brevity
    const loggableTaskList = taskListString.length > 300 ? `(Task list summary: ${tasks.length} tasks)` : taskListString;
    logToFile(`[Availability/getAIAssessment] Prompt context for ${staffName} - Projects: ${projectListString}. Tasks: ${loggableTaskList}`);

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 70, // Increased slightly for potentially longer reasoning
      temperature: 0.3,
    });
    const assessment = response.choices[0].message.content.trim();
    logToFile(`[Availability/getAIAssessment] AI response for ${staffName}: ${assessment}`);
    return assessment;
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
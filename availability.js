/**
 * Availability Module
 * Tracks team member availability and working hours
 */

// Timezone for all calculations (Berlin)
const TZ = 'Europe/Berlin';

// Staff availability module for showing team working hours
const moment = require('moment-timezone');

// Staff availability data - name, timezone, and working hours (24-hour format)
const STAFF_AVAILABILITY = [
  {
    name: "Armin",
    timezone: "Europe/Berlin",
    startHour: 9,
    endHour: 17.5,  // 17:30
    daysOff: [0, 6] // Sunday, Saturday
  },
  {
    name: "Amin",
    timezone: "Europe/Berlin",
    startHour: 7,
    endHour: 15.5,  // 15:30
    daysOff: [0, 6]
  },
  {
    name: "Ayoub",
    timezone: "Europe/Berlin",
    startHour: 9,
    endHour: 17.5,  // 17:30
    daysOff: [0, 6]
  },
  {
    name: "Jokubas",
    timezone: "Europe/Berlin",
    startHour: 9,
    endHour: 17.5,  // 17:30
    daysOff: [0, 6]
  },
  {
    name: "Dominik",
    timezone: "Europe/Berlin",
    startHour: 9,
    endHour: 17.5,  // 17:30
    daysOff: [0, 6]
  },
  {
    name: "Yovcho",
    timezone: "Europe/Berlin",
    startHour: 9,
    endHour: 17.5,  // 17:30
    daysOff: [0, 6]
  },
  {
    name: "Austin",
    timezone: "Europe/Berlin",
    startHour: 14.5, // 14:30
    endHour: 23,
    daysOff: [0, 6]
  },
  {
    name: "Nicholas Rice",
    timezone: "Europe/Berlin",
    startHour: 17,
    endHour: 23,
    daysOff: [0, 6]
  }
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
  const localTime = moment().tz(staff.timezone);
  const dayOfWeek = localTime.day(); // 0-6, starting with Sunday
  const hour = localTime.hour();
  
  // Check if today is a day off
  if (staff.daysOff && staff.daysOff.includes(dayOfWeek)) {
    return false;
  }
  
  // Check if current hour is within working hours
  return hour >= staff.startHour && hour < staff.endHour;
}

/**
 * Get formatted time left in shift for an active staff member
 * @param {Object} staff - Staff member object
 * @returns {string} Formatted time left in shift
 */
function getTimeLeftInShift(staff) {
  if (!isStaffActive(staff)) {
    return "Offline";
  }
  
  const localTime = moment().tz(staff.timezone);
  const now = localTime.hour() * 60 + localTime.minute();
  const shiftEnd = staff.endHour * 60;
  const minutesLeft = shiftEnd - now;
  
  const hours = Math.floor(minutesLeft / 60);
  const minutes = minutesLeft % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m left`;
  } else {
    return `${minutes}m left`;
  }
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
  if (staff.daysOff && staff.daysOff.includes(dayOfWeek)) {
    return `${staff.timezone}: Off today`;
  }
  
  // Get local time formatted
  const timeStr = localTime.format("HH:mm");
  
  // Calculate progress through shift
  const totalMinutesInShift = (staff.endHour - staff.startHour) * 60;
  const minutesSinceStart = (hour - staff.startHour) * 60 + min;
  
  // Handle times outside of working hours
  if (hour < staff.startHour) {
    return `${staff.timezone}: ${timeStr} (Starts at ${staff.startHour}:00)`;
  }
  
  if (hour >= staff.endHour) {
    return `${staff.timezone}: ${timeStr} (Ended at ${staff.endHour}:00)`;
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
  // Get days string
  const days = [0, 1, 2, 3, 4, 5, 6];
  const workDays = days.filter(day => !staff.daysOff.includes(day));
  
  const dayNames = workDays.map(day => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[day];
  }).join('-');
  
  return `${dayNames} ${staff.startHour}:00-${staff.endHour}:00`;
}

module.exports = {
  STAFF_AVAILABILITY,
  getCurrentBerlinTime,
  isStaffActive,
  getTimeLeftInShift,
  createTimeProgressBar,
  formatWorkingHours
}; 
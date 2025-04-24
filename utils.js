// Utils.js - Helper functions for Discord Scheduler Bot

/**
 * Calculate the time until the next execution of a cron job
 * @param {string} cronExpression - The cron expression in format 'minute hour day-of-month month day-of-week'
 * @param {string} timezone - The IANA timezone to use (e.g., 'Europe/Berlin')
 * @returns {Object|null} An object with information about the next execution time or null if error
 */
function getTimeUntilNextExecution(cronExpression, timezone) {
  try {
    // Use provided timezone or default to Europe/Berlin
    const TZ = timezone || process.env.TZ || 'Europe/Berlin';
    
    // Parse the cron expression
    const parts = cronExpression.split(' ');
    if (parts.length !== 5) {
      throw new Error('Invalid cron expression format');
    }
    
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    
    // Get current date in the specified timezone
    const now = new Date();
    const tzOptions = { timeZone: TZ };
    const tzNow = new Date(new Date().toLocaleString('en-US', tzOptions));
    
    // Function to find the next valid date based on cron parts
    function findNextValidDate(startDate) {
      // Deep copy the date to avoid modifying the original
      let date = new Date(startDate.getTime());
      
      // Handle day of week restriction (1-7 where 1 is Monday)
      if (dayOfWeek !== '*') {
        const daysToCheck = dayOfWeek.split(',').flatMap(part => {
          if (part.includes('-')) {
            const [start, end] = part.split('-').map(Number);
            const range = [];
            for (let i = start; i <= end; i++) {
              range.push(i);
            }
            return range;
          } else {
            return [Number(part)];
          }
        });
        
        // Convert JS day (0=Sunday) to cron day (1=Monday)
        let currentDay = date.getDay() === 0 ? 7 : date.getDay();
        
        // If current day is not in allowed days, find next allowed day
        if (!daysToCheck.includes(currentDay)) {
          let daysToAdd = 1;
          while (daysToAdd < 8) {
            currentDay = currentDay === 7 ? 1 : currentDay + 1;
            if (daysToCheck.includes(currentDay)) {
              break;
            }
            daysToAdd++;
          }
          
          // Add the days and reset time to the beginning of the day
          date.setDate(date.getDate() + daysToAdd);
          date.setHours(0, 0, 0, 0);
        }
      }
      
      // Handle hour and minute
      const targetHour = hour === '*' ? date.getHours() : parseInt(hour, 10);
      const targetMinute = minute === '*' ? date.getMinutes() : parseInt(minute, 10);
      
      // If time has already passed today, move to next occurrence
      if (
        date.getHours() > targetHour || 
        (date.getHours() === targetHour && date.getMinutes() >= targetMinute)
      ) {
        // If we're checking weekdays, we need to move to next valid day
        if (dayOfWeek !== '*') {
          date.setDate(date.getDate() + 1);
          date.setHours(0, 0, 0, 0);
          return findNextValidDate(date); // Recursive call to find next valid date
        } else {
          // For daily jobs, just move to next day
          date.setDate(date.getDate() + 1);
        }
      }
      
      // Set the target hour and minute
      date.setHours(targetHour, targetMinute, 0, 0);
      
      return date;
    }
    
    // Find the next execution date
    const nextDate = findNextValidDate(tzNow);
    
    // Calculate time difference
    const diff = nextDate.getTime() - now.getTime();
    
    // Convert milliseconds to hours, minutes, seconds
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    
    return {
      date: nextDate,
      formatted: nextDate.toLocaleString('en-US', { timeZone: TZ }),
      timeLeft: { hours, minutes, seconds },
      formattedTimeLeft: `${hours}h ${minutes}m ${seconds}s`
    };
  } catch (error) {
    console.error(`Error calculating next execution time: ${error.message}`);
    return null;
  }
}

module.exports = {
  getTimeUntilNextExecution
}; 
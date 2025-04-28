// test-cron.js - Test cron expressions
const cron = require('node-cron');
const moment = require('moment-timezone');

// Set timezone
const TZ = 'Europe/Berlin';

console.log(`Current time: ${new Date().toLocaleString()}`);
console.log(`Current time in ${TZ}: ${new Date().toLocaleString('en-US', { timeZone: TZ })}`);
console.log(`Day of week: ${new Date().getDay()} (JavaScript Date.getDay())`);
console.log(`Day of week (moment): ${moment().day()} (moment.day())`);
console.log(`Day of week (moment Berlin): ${moment().tz(TZ).day()} (moment.tz().day())`);
console.log('------------------------------');

// Test different day of week patterns
const testPatterns = [
  { pattern: '* * * * *', description: 'Every minute (should be valid)' },
  { pattern: '0 9 * * 1-5', description: 'Weekdays at 9am' },
  { pattern: '0 9 * * 1,2,3,4,5', description: 'Explicit weekdays at 9am' },
  { pattern: '0 9 * * 0,6', description: 'Weekends at 9am' },
  { pattern: '0 9 * * 1', description: 'Mondays at 9am' }
];

console.log('Testing cron patterns:');
testPatterns.forEach((test, index) => {
  try {
    // Try to validate the pattern
    const isValid = cron.validate(test.pattern);
    console.log(`${index + 1}. ${test.pattern} - ${test.description}`);
    console.log(`   Valid: ${isValid ? '✅ Yes' : '❌ No'}`);
    
    if (isValid) {
      // Try to get next execution time
      const scheduler = cron.schedule(test.pattern, () => {}, { 
        timezone: TZ,
        scheduled: false 
      });
      
      const nextDate = scheduler.nextDate().toDate();
      const formattedDate = nextDate.toLocaleString('en-US', { timeZone: TZ });
      
      console.log(`   Next execution: ${formattedDate}`);
      console.log(`   Day of week: ${nextDate.getDay()} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][nextDate.getDay()]})`);
      
      // Calculate time until next execution
      const now = new Date();
      const diffMs = nextDate - now;
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
      
      console.log(`   Time until next: ${hours}h ${minutes}m ${seconds}s`);
      
      scheduler.stop();
    }
  } catch (error) {
    console.log(`   ERROR: ${error.message}`);
  }
  
  console.log('');
});

// Test cron expressions from the actual jobs array
console.log('Testing job cron expressions:');
const jobCrons = [
  { tag: 'Morning Stand-up', cron: '0 9 * * 1-5' },
  { tag: 'Lunch Break', cron: '0 12 * * 1-5' },
  { tag: 'Client Call', cron: '0 16 * * 1,3,5' },
  { tag: 'Project Planning', cron: '0 16 * * 2,4' },
];

jobCrons.forEach((job, index) => {
  try {
    console.log(`${index + 1}. ${job.tag} (${job.cron})`);
    
    // Try to get next execution time
    const scheduler = cron.schedule(job.cron, () => {}, { 
      timezone: TZ,
      scheduled: false 
    });
    
    const nextDate = scheduler.nextDate().toDate();
    const formattedDate = nextDate.toLocaleString('en-US', { timeZone: TZ });
    
    console.log(`   Next execution: ${formattedDate}`);
    console.log(`   Day of week: ${nextDate.getDay()} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][nextDate.getDay()]})`);
    
    // Calculate time until next execution
    const now = new Date();
    const diffMs = nextDate - now;
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
    
    console.log(`   Time until next: ${hours}h ${minutes}m ${seconds}s`);
    
    scheduler.stop();
  } catch (error) {
    console.log(`   ERROR: ${error.message}`);
  }
  
  console.log('');
}); 
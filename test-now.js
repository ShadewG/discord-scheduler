// Simple test script to check the bot can calculate next execution times

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Import the functions from index.js for testing
const { getTimeUntilNextExecution } = require('./utils');

const TZ = process.env.TZ || 'Europe/Berlin';
console.log(`Using timezone: ${TZ}`);
console.log(`Current time: ${new Date().toLocaleString('en-US', { timeZone: TZ })} (${TZ})`);
console.log('');

// Sample jobs for testing
const testJobs = [
  { tag: 'fika-heads-up', cron: '50 8 * * 1-5' },
  { tag: 'deep-work-am', cron: '20 9 * * 1-5' },
  { tag: 'fika-break', cron: '0 11 * * 1-5' },
  { tag: 'lunch-break', cron: '0 13 * * 1-5' },
  { tag: 'wrap-up-heads-up', cron: '50 16 * * 1-5' },
  // Add tests for specific cases
  { tag: 'test-daily', cron: '30 12 * * *' },
  { tag: 'test-weekend', cron: '45 10 * * 0,6' },
  { tag: 'test-specific-day', cron: '15 14 * * 3' } // Wednesday
];

console.log('Testing next execution times:');
testJobs.forEach(job => {
  try {
    console.log(`\nJob: ${job.tag} (${job.cron})`);
    const nextExecution = getTimeUntilNextExecution(job.cron);
    
    if (nextExecution) {
      console.log(`- Next execution: ${nextExecution.formatted}`);
      console.log(`- Time until next: ${nextExecution.formattedTimeLeft}`);
    } else {
      console.log('Failed to calculate next execution time');
    }
  } catch (error) {
    console.error(`Error with job ${job.tag}:`, error.message);
  }
});

// Test a custom cron expression from command line argument if provided
if (process.argv.length > 2) {
  const customCron = process.argv[2];
  console.log(`\nTesting custom cron expression: ${customCron}`);
  try {
    const nextExecution = getTimeUntilNextExecution(customCron);
    if (nextExecution) {
      console.log(`- Next execution: ${nextExecution.formatted}`);
      console.log(`- Time until next: ${nextExecution.formattedTimeLeft}`);
    } else {
      console.log('Failed to calculate next execution time for custom expression');
    }
  } catch (error) {
    console.error('Error with custom cron expression:', error.message);
  }
} 
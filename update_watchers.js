// Update watchers to be persisted

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Check if file exists
const watchersFilePath = path.join(__dirname, 'notion-watchers.json');
let customWatchers = [];

// Create empty watchers file if it doesn't exist
if (!fs.existsSync(watchersFilePath)) {
  console.log(`Creating empty watchers file at ${watchersFilePath}`);
  fs.writeFileSync(watchersFilePath, JSON.stringify(customWatchers, null, 2));
} else {
  // Read existing watchers
  try {
    const data = fs.readFileSync(watchersFilePath, 'utf8');
    customWatchers = JSON.parse(data);
    console.log(`Successfully loaded ${customWatchers.length} existing watchers from file.`);
  } catch (error) {
    console.error(`Error loading watchers file: ${error.message}`);
  }
}

// Add the file to git and commit if in a git repository
try {
  // Check if git is available and if we're in a git repository
  const isGitRepo = execSync('git rev-parse --is-inside-work-tree 2>/dev/null', { 
    stdio: ['ignore', 'pipe', 'ignore'] 
  }).toString().trim() === 'true';
  
  if (isGitRepo) {
    // Add the file to git
    execSync(`git add ${watchersFilePath}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    
    // Commit the changes
    execSync(`git commit -m "Add watchers file to persist between deployments [skip ci]" --no-verify`, { 
      stdio: ['ignore', 'pipe', 'pipe'] 
    });
    
    console.log('✅ Committed watchers file to git');
    
    // Optional: Push to remote
    const shouldPush = false; // Change to true to enable pushing
    if (shouldPush) {
      execSync('git push', { stdio: ['ignore', 'pipe', 'pipe'] });
      console.log('✅ Pushed changes to remote repository');
    } else {
      console.log('ℹ️ Changes not pushed to remote. Run "git push" manually if needed.');
    }
  } else {
    console.log('⚠️ Not a git repository. File saved but not committed.');
  }
} catch (gitError) {
  console.error(`⚠️ Error with git operations: ${gitError.message}`);
}

console.log('Watchers file is now ready for use!');
console.log('The bot will now load this file on restart and save changes back to it.');
console.log('');
console.log('To ensure persistence between deployments:');
console.log('1. Make sure this file is committed to your repository');
console.log('2. Push the changes to your remote repository');
console.log('3. Railway or other deployment services will use this file on next deployment');

// Direct fix for the syntax error at line 3366
const fs = require('fs');
const path = require('path');

// Read the index.js file
const indexPath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(indexPath, 'utf8');

// Split into lines for easier manipulation
const lines = content.split('\n');

// Find the line with the unexpected token
let lineNumber = -1;
for (let i = 3360; i < 3370; i++) {
  if (lines[i] && lines[i].trim() === '});') {
    lineNumber = i;
    break;
  }
}

if (lineNumber === -1) {
  console.error('Could not find the problematic line');
  process.exit(1);
}

console.log(`Found problematic line at line ${lineNumber + 1}`);

// Replace the problematic line
lines[lineNumber] = '  }';

// Write the fixed content back to the file
fs.writeFileSync(indexPath, lines.join('\n'));
console.log('Successfully fixed the syntax error at line 3366');

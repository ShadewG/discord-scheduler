// Script to fix the syntax error in index.js
const fs = require('fs');
const path = require('path');

// Read the index.js file
const indexPath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(indexPath, 'utf8');

// Find the problematic line
const problemLine = content.indexOf("else if (['next', 'list', 'status', 'help', 'edit'].includes(commandName))");
if (problemLine === -1) {
  console.error('Could not find the problematic line');
  process.exit(1);
}

// Find the start of the line
let lineStart = problemLine;
while (lineStart > 0 && content[lineStart - 1] !== '\n') {
  lineStart--;
}

// Check if there's an if statement before this else
let beforeElse = content.substring(0, lineStart).trim();
const lastChar = beforeElse.charAt(beforeElse.length - 1);

// Fix the syntax error by replacing 'else if' with 'if'
content = content.substring(0, lineStart) + 
          content.substring(lineStart).replace(
            "else if (['next', 'list', 'status', 'help', 'edit'].includes(commandName))",
            "if (['next', 'list', 'status', 'help', 'edit'].includes(commandName))"
          );

// Write the updated content back to the file
fs.writeFileSync(indexPath, content);
console.log('Successfully fixed the syntax error in index.js');

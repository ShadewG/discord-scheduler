const fs = require('fs');
const path = require('path');

// Read the file
const filePath = path.join(__dirname, 'index.js');
console.log(`Opening file: ${filePath}`);
let content = fs.readFileSync(filePath, 'utf8');
console.log(`File size: ${content.length} bytes`);

// Replace the duplicate path declaration
const duplicatePathDeclaration = "const path = require('path');";
const replacementLine = "// path is already required at the top of the file";

// Find all instances of path declaration
console.log("Searching for all path declarations...");
const allLines = content.split('\n');
allLines.forEach((line, index) => {
  if (line.includes("path = require") || line.includes("path=require")) {
    console.log(`Line ${index + 1}: ${line.trim()}`);
  }
});

// Focus specifically on the problematic area
console.log("\nFocusing on the problematic area...");
const startLine = Math.max(0, 5390);
const endLine = Math.min(allLines.length, 5405);

console.log(`File has ${allLines.length} lines total`);
console.log(`Scanning lines ${startLine} to ${endLine} for duplicate path declaration...`);

// Output the lines in the range for debugging
console.log("\nLines in range:");
for (let i = startLine; i < endLine; i++) {
  console.log(`Line ${i + 1}: ${allLines[i]}`);
}

// Check if there's a duplicate declaration in this range
let found = false;
for (let i = startLine; i < endLine; i++) {
  if (allLines[i].includes(duplicatePathDeclaration)) {
    console.log(`\nFound duplicate path declaration at line ${i + 1}: ${allLines[i]}`);
    allLines[i] = replacementLine;
    found = true;
    break;
  }
}

// If found, write the modified content back to the file
if (found) {
  console.log('Fixing duplicate path declaration...');
  fs.writeFileSync(filePath, allLines.join('\n'));
  console.log('File updated successfully!');
} else {
  console.log('No duplicate path declaration found in the specified range.');
} 
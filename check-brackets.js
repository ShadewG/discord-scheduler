// Script to check for balanced brackets and fix any issues
const fs = require('fs');
const path = require('path');

// Read the index.js file
const indexPath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(indexPath, 'utf8');

// Check for balanced brackets
function checkBalancedBrackets(code) {
  const stack = [];
  const brackets = {
    '{': '}',
    '(': ')',
    '[': ']'
  };
  
  let lineNumber = 1;
  let lastOpeningBracket = null;
  let lastOpeningLine = 0;
  
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    
    // Track line numbers
    if (char === '\n') {
      lineNumber++;
      continue;
    }
    
    // Check opening brackets
    if (brackets[char]) {
      stack.push({ char, line: lineNumber });
      lastOpeningBracket = char;
      lastOpeningLine = lineNumber;
      continue;
    }
    
    // Check closing brackets
    if (Object.values(brackets).includes(char)) {
      const expected = stack.pop();
      if (!expected || brackets[expected.char] !== char) {
        console.log(`Mismatched bracket at line ${lineNumber}: expected ${expected ? brackets[expected.char] : 'none'} but found ${char}`);
      }
    }
  }
  
  // Check for unclosed brackets
  if (stack.length > 0) {
    console.log(`Found ${stack.length} unclosed brackets:`);
    stack.forEach(item => {
      console.log(`- ${item.char} opened at line ${item.line} is not closed`);
    });
    return { balanced: false, stack };
  }
  
  return { balanced: true };
}

// Check if the file has balanced brackets
const result = checkBalancedBrackets(content);

// Fix the file if needed
if (!result.balanced) {
  console.log('Fixing unbalanced brackets...');
  
  // Add missing closing brackets at the end of the file
  let fixedContent = content;
  
  result.stack.reverse().forEach(item => {
    const closingBracket = item.char === '{' ? '}' : (item.char === '(' ? ')' : ']');
    fixedContent += closingBracket + '\n';
    console.log(`Added missing ${closingBracket} for ${item.char} opened at line ${item.line}`);
  });
  
  // Write the fixed content back to the file
  fs.writeFileSync(indexPath, fixedContent);
  console.log('Successfully fixed unbalanced brackets in index.js');
} else {
  console.log('All brackets are balanced in index.js');
}

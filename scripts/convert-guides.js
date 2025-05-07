// Script to convert PDF guides to text files for more efficient storage and processing
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

// Directories
const GUIDES_DIR = path.join(__dirname, '..', 'guides');
const TEXT_GUIDES_DIR = path.join(__dirname, '..', 'guides', 'text');

// Ensure text guides directory exists
if (!fs.existsSync(TEXT_GUIDES_DIR)) {
  fs.mkdirSync(TEXT_GUIDES_DIR, { recursive: true });
  console.log(`Created directory: ${TEXT_GUIDES_DIR}`);
}

// Function to extract text from a PDF file
async function extractTextFromPDF(pdfPath) {
  try {
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  } catch (error) {
    console.error(`Error extracting text from ${pdfPath}: ${error.message}`);
    return null;
  }
}

// Function to convert a PDF to a text file
async function convertPDFToText(pdfPath) {
  const pdfName = path.basename(pdfPath, '.pdf');
  const textFilePath = path.join(TEXT_GUIDES_DIR, `${pdfName}.txt`);
  const jsonFilePath = path.join(TEXT_GUIDES_DIR, `${pdfName}.json`);
  
  console.log(`Converting ${pdfName}...`);
  
  // Extract text from PDF
  const text = await extractTextFromPDF(pdfPath);
  if (!text) {
    console.log(`Skipping ${pdfName} due to extraction error`);
    return false;
  }
  
  // Save as plain text
  fs.writeFileSync(textFilePath, text);
  
  // Save as JSON with metadata
  const metadata = {
    title: pdfName,
    sourceFile: path.basename(pdfPath),
    extractedAt: new Date().toISOString(),
    contentLength: text.length,
    content: text
  };
  
  fs.writeFileSync(jsonFilePath, JSON.stringify(metadata, null, 2));
  
  console.log(`Successfully converted ${pdfName} to text and JSON files`);
  return true;
}

// Convert all PDFs in the guides directory
async function convertAllPDFs() {
  try {
    // Get all PDF files
    const pdfFiles = fs.readdirSync(GUIDES_DIR)
      .filter(file => file.toLowerCase().endsWith('.pdf'))
      .map(file => path.join(GUIDES_DIR, file));
    
    console.log(`Found ${pdfFiles.length} PDF files to convert`);
    
    // Convert each PDF
    let successCount = 0;
    for (const pdfFile of pdfFiles) {
      const success = await convertPDFToText(pdfFile);
      if (success) successCount++;
    }
    
    console.log(`Conversion complete: ${successCount}/${pdfFiles.length} files converted successfully`);
  } catch (error) {
    console.error(`Error converting PDFs: ${error.message}`);
  }
}

// Run the conversion process
convertAllPDFs().then(() => {
  console.log('Conversion process finished');
}); 
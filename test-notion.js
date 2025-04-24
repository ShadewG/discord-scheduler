// Test script for Notion integration
require('dotenv').config();
const { Client } = require('@notionhq/client');

// Setup
const NOTION_TOKEN = process.env.NOTION_TOKEN;
let rawDatabaseId = process.env.NOTION_DB_ID;

if (!NOTION_TOKEN) {
  console.error('❌ NOTION_TOKEN not found in environment variables');
  console.error('   Please set it in your .env file: NOTION_TOKEN=secret_xxx');
  process.exit(1);
}

if (!rawDatabaseId) {
  console.error('❌ NOTION_DB_ID not found in environment variables');
  console.error('   Please set it in your .env file: NOTION_DB_ID=83c7a9f1...');
  process.exit(1);
}

// Remove hyphens from database ID if present
const databaseId = rawDatabaseId.replace(/-/g, '');

console.log('=== Notion Integration Test ===');
console.log(`Token: ${NOTION_TOKEN.substring(0, 7)}...`);
console.log(`Raw Database ID: ${rawDatabaseId}`);
console.log(`Processed Database ID: ${databaseId}`);

// Initialize Notion client
const notion = new Client({ auth: NOTION_TOKEN });

async function testNotionConnection() {
  console.log('\n1️⃣ Testing Notion API connection...');
  
  try {
    // Test the connection with a simple users.me call
    const user = await notion.users.me();
    console.log(`✅ Connected to Notion as: ${user.name} (${user.type})`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to connect to Notion API: ${error.message}`);
    if (error.code === 'unauthorized') {
      console.error('   Your NOTION_TOKEN might be invalid or expired');
    }
    return false;
  }
}

async function testDatabaseAccess() {
  console.log('\n2️⃣ Testing database access...');
  
  try {
    // Try to query the database
    const response = await notion.databases.retrieve({
      database_id: databaseId
    });
    
    console.log(`✅ Successfully accessed database: "${response.title[0]?.plain_text || '(Untitled database)'}"`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to access database: ${error.message}`);
    
    if (error.code === 'object_not_found') {
      console.error('   - Database ID might be incorrect');
      console.error('   - Integration might not have access to this database');
      console.error('   - Make sure you shared the database with your integration');
      console.error(`   - Try sharing: https://www.notion.so/${databaseId.substring(0, 8)}...${databaseId.substring(databaseId.length - 4)}`);
    }
    
    return false;
  }
}

async function testDatabaseProperties() {
  console.log('\n3️⃣ Testing database properties...');
  
  try {
    // Get database properties
    const database = await notion.databases.retrieve({
      database_id: databaseId
    });
    
    const properties = database.properties;
    const TARGET_PROP = 'Caption Status';
    const TITLE_PROP = 'Project Name';
    
    console.log(`Found ${Object.keys(properties).length} properties in the database:`);
    
    let hasCaptionStatus = false;
    let hasTitle = false;
    let titlePropertyName = null;
    
    for (const [name, property] of Object.entries(properties)) {
      const type = property.type;
      console.log(`   - "${name}" (${type})`);
      
      if (name === TARGET_PROP && type === 'select') {
        hasCaptionStatus = true;
      }
      
      if (type === 'title') {
        hasTitle = true;
        titlePropertyName = name;
      }
    }
    
    if (hasCaptionStatus) {
      console.log(`✅ Found required "${TARGET_PROP}" property with type "select"`);
    } else {
      console.error(`❌ "${TARGET_PROP}" property either doesn't exist or is not a "select" type`);
    }
    
    if (hasTitle) {
      console.log(`✅ Found a title property named "${titlePropertyName}"`);
      if (titlePropertyName !== TITLE_PROP) {
        console.warn(`⚠️  Warning: Title property is named "${titlePropertyName}" but code expects "${TITLE_PROP}"`);
        console.warn(`    You should update the code in index.js to use "${titlePropertyName}" instead of "${TITLE_PROP}"`);
      }
    } else {
      console.error(`❌ No title property found in the database`);
    }
    
    return hasCaptionStatus && hasTitle;
  } catch (error) {
    console.error(`❌ Failed to get database properties: ${error.message}`);
    return false;
  }
}

async function testQueryWithFilter() {
  console.log('\n4️⃣ Testing database query with filter...');
  
  const TARGET_PROP = 'Caption Status';
  const TARGET_VALUE = 'Ready For Captions'; 
  const TITLE_PROP = 'Project Name';
  
  try {
    // Try to query with filter
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: TARGET_PROP,
        select: { equals: TARGET_VALUE }
      }
    });
    
    console.log(`✅ Query successful. Found ${response.results.length} pages with "${TARGET_PROP}" = "${TARGET_VALUE}"`);
    
    if (response.results.length > 0) {
      console.log('\nExample pages:');
      response.results.slice(0, 3).forEach((page, index) => {
        // Check if page has the Project Name property
        if (!page.properties[TITLE_PROP]) {
          console.error(`❌ Page is missing the "${TITLE_PROP}" property. Available properties: ${Object.keys(page.properties).join(', ')}`);
          // Try to find any title property
          const titleProp = Object.entries(page.properties).find(([_, prop]) => prop.type === 'title');
          if (titleProp) {
            console.log(`   Found alternative title property: "${titleProp[0]}"`);
          }
        }
        
        const title = page.properties[TITLE_PROP]?.title?.[0]?.plain_text || '(Untitled)';
        const lastEdited = new Date(page.last_edited_time).toISOString();
        console.log(`   ${index+1}. "${title}" (Last edited: ${lastEdited})`);
      });
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Failed to query database with filter: ${error.message}`);
    
    if (error.code === 'validation_error') {
      console.error(`   - Property "${TARGET_PROP}" might not exist`);
      console.error(`   - Property "${TARGET_PROP}" might not be a Select type`);
    }
    
    return false;
  }
}

async function runAllTests() {
  console.log('\n=== Starting Tests ===');
  
  const connectionSuccess = await testNotionConnection();
  if (!connectionSuccess) {
    console.error('\n❌ Failed to connect to Notion API. Stopping tests.');
    return;
  }
  
  const databaseSuccess = await testDatabaseAccess();
  if (!databaseSuccess) {
    console.error('\n❌ Failed to access database. Stopping tests.');
    return;
  }
  
  const propertiesSuccess = await testDatabaseProperties();
  if (!propertiesSuccess) {
    console.error('\n⚠️ Database properties check failed. Continuing...');
  }
  
  const querySuccess = await testQueryWithFilter();
  if (!querySuccess) {
    console.error('\n❌ Failed to query database with filter.');
  }
  
  console.log('\n=== Test Results ===');
  if (connectionSuccess && databaseSuccess && propertiesSuccess && querySuccess) {
    console.log('✅ All tests passed! Your Notion integration should work correctly.');
  } else {
    console.log('⚠️ Some tests failed. See the issues above for troubleshooting.');
  }
}

// Run all tests
runAllTests().catch(error => {
  console.error('Unhandled error during tests:', error);
}); 
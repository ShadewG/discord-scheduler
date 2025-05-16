require('dotenv').config(); // Ensure environment variables are loaded
const { Client: NotionClient } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

// Initialize Notion client (ensure NOTION_KEY is available in your environment)
const notion = process.env.NOTION_KEY ? new NotionClient({ auth: process.env.NOTION_KEY }) : null;
if (notion) {
  console.log('[NotionUtils] Notion client initialized successfully.');
} else {
  console.error('[NotionUtils] FAILED to initialize Notion client. NOTION_KEY might be missing or invalid.');
}

// Database IDs
const PROJECTS_DATABASE_ID = process.env.NOTION_DATABASE_ID || process.env.NOTION_DB_ID;
const TASKS_DATABASE_ID = '1e787c20070a80319db0f8a08f255c3c'; // As specified by user
console.log(`[NotionUtils] Using PROJECTS_DATABASE_ID: ${PROJECTS_DATABASE_ID}`);
console.log(`[NotionUtils] Using TASKS_DATABASE_ID: ${TASKS_DATABASE_ID}`);

// Helper function for logging (if you have one, otherwise implement or remove)
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [NotionUtils] ${message}\n`;
  try {
    fs.appendFileSync(path.join(__dirname, 'bot.log'), logMessage);
  } catch (e) {
    console.log(logMessage.trim());
  }
}

/**
 * Fetches projects assigned to a user from the main projects database.
 * @param {string} notionProjectOwnerName - The name of the user as it appears in the "Project Owner" field.
 * @returns {Promise<Array<Object>>} A list of project objects or an empty array.
 */
async function fetchActiveProjectsForUser(notionProjectOwnerName) {
  if (!notion) {
    logToFile('Notion client not initialized. Cannot fetch projects.');
    return [];
  }
  if (!PROJECTS_DATABASE_ID) {
    logToFile('Projects Database ID not configured. Cannot fetch projects.');
    return [];
  }
  if (!notionProjectOwnerName) {
    logToFile('Notion project owner name not provided. Cannot fetch projects.');
    return [];
  }

  const filter = {
    and: [
      {
        property: 'Project Owner',
        select: { 
          equals: notionProjectOwnerName,
        },
      },
      {
        property: 'Status', 
        status: { // Assumes 'Status' is a STATUS type property in Notion
          does_not_equal: 'Done',
        },
      },
        {
        property: 'Status',
        status: { // Assumes 'Status' is a STATUS type property in Notion
          does_not_equal: 'Archived',
        },
      }
    ],
  };

  try {
    logToFile(`Fetching projects for Project Owner: ${notionProjectOwnerName} using DB ID: ${PROJECTS_DATABASE_ID}`);
    logToFile(`Projects filter: ${JSON.stringify(filter, null, 2)}`);
    
    const response = await notion.databases.query({
      database_id: PROJECTS_DATABASE_ID,
      filter: filter,
      sorts: [
        {
          property: 'Project name',
          direction: 'ascending',
        },
      ],
    });

    logToFile(`Raw projects response for ${notionProjectOwnerName} received ${response.results.length} items.`);
    if (response.results.length > 0) {
        logToFile(`First project raw properties for ${notionProjectOwnerName}: ${JSON.stringify(response.results[0].properties, null, 2)}`);
    }

    const projects = response.results.map(page => {
      const projectNameProperty = page.properties['Project name'] || page.properties['Name'];
      return {
        id: page.id,
        name: projectNameProperty?.title?.[0]?.plain_text || 'Unnamed Project',
        status: page.properties['Status']?.status?.name || page.properties['Status']?.select?.name || 'No Status',
        url: page.url,
      };
    });
    logToFile(`Found ${projects.length} active projects for ${notionProjectOwnerName}.`);
    return projects;
  } catch (error) {
    logToFile(`Error fetching projects for ${notionProjectOwnerName}: ${error.message}\nStack: ${error.stack}`);
    console.error(`Error fetching projects for ${notionProjectOwnerName}:`, error);
    return [];
  }
}

/**
 * Fetches active tasks assigned to a user from the tasks database.
 * @param {string} notionTaskAssigneeName - The name of the user as it appears in the "Assignee" field.
 * @returns {Promise<Array<Object>>} A list of task objects or an empty array.
 */
async function fetchActiveTasksForUser(notionTaskAssigneeName) {
  if (!notion) {
    logToFile('Notion client not initialized. Cannot fetch tasks.');
    return [];
  }
  if (!TASKS_DATABASE_ID) {
    logToFile('Tasks Database ID not configured. Cannot fetch tasks.');
    return [];
  }
  if (!notionTaskAssigneeName) {
    logToFile('Notion task assignee name not provided. Cannot fetch tasks.');
    return [];
  }

  const filter = {
    and: [
      {
        property: 'Assignee', 
        select: { // Assumes 'Assignee' is a SELECT type property
          equals: notionTaskAssigneeName,
        },
      },
      {
        property: 'Progress', 
        select: { // Assumes 'Progress' is a SELECT type property
          does_not_equal: 'Done',
        },
      },
    ],
  };

  try {
    logToFile(`Fetching tasks for Assignee: ${notionTaskAssigneeName} using DB ID: ${TASKS_DATABASE_ID}`);
    logToFile(`Tasks filter: ${JSON.stringify(filter, null, 2)}`);

    const response = await notion.databases.query({
      database_id: TASKS_DATABASE_ID,
      filter: filter,
    });

    logToFile(`Raw tasks response for ${notionTaskAssigneeName} received ${response.results.length} items.`);
    if (response.results.length > 0) {
        logToFile(`First task raw properties for ${notionTaskAssigneeName}: ${JSON.stringify(response.results[0].properties, null, 2)}`);
    }

    const tasks = response.results.map(page => {
      const taskNameProperty = page.properties['title'] || page.properties['Name'] || page.properties['Task'];
      return {
        id: page.id,
        name: taskNameProperty?.title?.[0]?.plain_text || 'Unnamed Task',
        status: page.properties['Progress']?.select?.name || page.properties['Progress']?.status?.name || 'No Status',
        url: page.url,
      };
    });
    logToFile(`Found ${tasks.length} active tasks for ${notionTaskAssigneeName}.`);
    return tasks;
  } catch (error) {
    logToFile(`Error fetching tasks for ${notionTaskAssigneeName}: ${error.message}\nStack: ${error.stack}`);
    console.error(`Error fetching tasks for ${notionTaskAssigneeName}:`, error);
    return [];
  }
}

module.exports = {
  fetchActiveProjectsForUser,
  fetchActiveTasksForUser,
}; 
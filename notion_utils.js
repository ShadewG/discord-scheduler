const { Client: NotionClient } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

// Initialize Notion client (ensure NOTION_KEY is available in your environment)
const notion = process.env.NOTION_KEY ? new NotionClient({ auth: process.env.NOTION_KEY }) : null;

// Database IDs
const PROJECTS_DATABASE_ID = process.env.NOTION_DATABASE_ID || process.env.NOTION_DB_ID;
const TASKS_DATABASE_ID = '1e787c20070a80319db0f8a08f255c3c'; // As specified by user

// Helper function for logging (if you have one, otherwise implement or remove)
function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [NotionUtils] ${message}\n`;
  // Assuming a logToFile function exists in your main bot file or a shared utility
  // If not, you might want to console.log or use a simple fs.appendFileSync here
  try {
    // This is a placeholder, adjust if your main logToFile is accessible differently
    // or implement a local one.
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

  try {
    logToFile(`Fetching projects for Project Owner: ${notionProjectOwnerName}`);
    const response = await notion.databases.query({
      database_id: PROJECTS_DATABASE_ID,
      filter: {
        and: [
          {
            property: 'Project Owner', // Confirmed as Select property by user
            select: { // Changed from 'people' to 'select'
              equals: notionProjectOwnerName,
            },
          },
          {
            property: 'Status',
            status: {
              does_not_equal: 'Done',
            },
          },
           {
            property: 'Status',
            status: {
              does_not_equal: 'Archived',
            },
          }
        ],
      },
      sorts: [
        {
          property: 'Project name',
          direction: 'ascending',
        },
      ],
    });

    const projects = response.results.map(page => {
      const projectNameProperty = page.properties['Project name'] || page.properties['Name']; // Common names for title
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
    logToFile(`Error fetching projects for ${notionProjectOwnerName}: ${error.message}`);
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

  try {
    logToFile(`Fetching tasks for Assignee: ${notionTaskAssigneeName}`);
    const response = await notion.databases.query({
      database_id: TASKS_DATABASE_ID,
      filter: {
        and: [
          {
            property: 'Assignee', // Assuming this is the correct property name
            select: { // Or 'people' if it's a person property
              equals: notionTaskAssigneeName,
            },
          },
          {
            property: 'Progress', // Assuming this is the status property for tasks
            select: { // Or 'status' if it's a status property
              does_not_equal: 'Done',
            },
          },
        ],
      },
    });

    const tasks = response.results.map(page => {
      const taskNameProperty = page.properties['title'] || page.properties['Name'] || page.properties['Task']; // Common names for task title
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
    logToFile(`Error fetching tasks for ${notionTaskAssigneeName}: ${error.message}`);
    console.error(`Error fetching tasks for ${notionTaskAssigneeName}:`, error);
    return [];
  }
}

module.exports = {
  fetchActiveProjectsForUser,
  fetchActiveTasksForUser,
}; 
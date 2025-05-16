const { Client: NotionClient } = require('@notionhq/client');
const fs = require('fs');
const { logToFile } = require('./log_utils'); // Assuming logToFile is now in a separate utility

const NOTION_KEY_UTILS = process.env.NOTION_KEY || process.env.NOTION_TOKEN;
const PROJECTS_DATABASE_ID = process.env.NOTION_PROJECTS_DATABASE_ID || '1c987c20070a807aa617deddc3c9bb43'; // Default as per logs
const TASKS_DATABASE_ID = process.env.NOTION_TASKS_DATABASE_ID || '1e787c20070a80319db0f8a08f255c3c';     // Default as per logs

// --- Detailed Key Logging ---
let keyDebugInfo = `[NotionUtils] Attempting to use Notion Key. Retrieved from process.env: '${NOTION_KEY_UTILS}'. `;
if (NOTION_KEY_UTILS && typeof NOTION_KEY_UTILS === 'string') {
  keyDebugInfo += `Type: string, Length: ${NOTION_KEY_UTILS.length}. First 5 chars: '${NOTION_KEY_UTILS.substring(0,5)}'.`;
} else if (NOTION_KEY_UTILS) {
  keyDebugInfo += `Type: ${typeof NOTION_KEY_UTILS}. Value: ${String(NOTION_KEY_UTILS)}.`;
} else {
  keyDebugInfo += `Value is undefined or null.`;
}
console.log(keyDebugInfo);
logToFile(keyDebugInfo);
// --- End Detailed Key Logging ---

let notionUtilsClient = null;

if (NOTION_KEY_UTILS && typeof NOTION_KEY_UTILS === 'string' && NOTION_KEY_UTILS.trim() !== '') {
  try {
    notionUtilsClient = new NotionClient({ auth: NOTION_KEY_UTILS });
    const successMsg = '[NotionUtils] Notion client in notion_utils.js initialized successfully.';
    console.log(successMsg);
    logToFile(successMsg);
  } catch (error) {
    const errorMsg = `[NotionUtils] FAILED to initialize Notion client in notion_utils.js. Key effectively used (first 5 chars): '${NOTION_KEY_UTILS ? NOTION_KEY_UTILS.substring(0,5) : "N/A"}'. Error: ${error.message}`;
    console.error(errorMsg);
    logToFile(`${errorMsg} Stack: ${error.stack}`);
  }
} else {
  const warnMsg = `[NotionUtils] NOTION_KEY is missing, undefined, or empty in notion_utils.js. Cannot initialize client. Value: '${NOTION_KEY_UTILS}', Type: ${typeof NOTION_KEY_UTILS}.`;
  console.warn(warnMsg);
  logToFile(warnMsg);
}

logToFile(`[NotionUtils] Using PROJECTS_DATABASE_ID: ${PROJECTS_DATABASE_ID}`);
logToFile(`[NotionUtils] Using TASKS_DATABASE_ID: ${TASKS_DATABASE_ID}`);

/**
 * Fetches projects assigned to a user from the main projects database.
 * @param {string} notionProjectOwnerName - The name of the user as it appears in the "Project Owner" field.
 * @returns {Promise<Array<Object>>} A list of project objects or an empty array.
 */
async function fetchActiveProjectsForUser(staff) {
  logToFile(`[NotionUtils] fetchActiveProjectsForUser called with staff: ${JSON.stringify(staff)}`);
  if (!notionUtilsClient) {
    logToFile('[NotionUtils] fetchActiveProjectsForUser: notionUtilsClient is not initialized!');
    return [];
  }
  if (!staff || (!staff.notionProjectOwnerName && !staff.notionTaskAssigneeName)) {
    logToFile('[NotionUtils] fetchActiveProjectsForUser: Staff Notion names not provided or empty for projects.');
    return [];
  }
  // Ensure we only proceed if notionProjectOwnerName is present for project fetching
  if (!staff.notionProjectOwnerName) {
    logToFile('[NotionUtils] fetchActiveProjectsForUser: staff.notionProjectOwnerName is missing. Cannot fetch projects based on owner.');
    return [];
  }

  const databaseId = PROJECTS_DATABASE_ID;
  const filterConditions = [];

  filterConditions.push({
    property: "Project Owner",
    select: {
      equals: staff.notionProjectOwnerName,
    },
  });

  filterConditions.push({
    property: "Status",
    status: {
      does_not_equal: "Done",
    },
  });
  filterConditions.push({
    property: "Status",
    status: {
      does_not_equal: "Archived",
    },
  });

  const fullFilter = { and: filterConditions };
  logToFile(`[NotionUtils] Querying Projects DB (${databaseId}) for ${staff.name} (Owner: ${staff.notionProjectOwnerName}). Filter: ${JSON.stringify(fullFilter)}`);

  try {
    const response = await notionUtilsClient.databases.query({
      database_id: databaseId,
      filter: fullFilter,
    });
    logToFile(`[NotionUtils] Projects query for ${staff.name} (Owner: ${staff.notionProjectOwnerName}) returned ${response.results.length} results.`);
    if (response.results.length > 0) {
      logToFile(`[NotionUtils] First project raw data for ${staff.name}: ID: ${response.results[0].id}, Properties: ${JSON.stringify(response.results[0].properties)}`);
    }
    return response.results.map(page => ({
      id: page.id,
      name: page.properties["Project name"]?.title[0]?.plain_text || "Untitled Project",
    }));
  } catch (error) {
    logToFile(`[NotionUtils] Error fetching projects for ${staff.name}: ${error.message}\nStack: ${error.stack}`);
    console.error(`[NotionUtils] Error fetching projects for ${staff.name}:`, error);
    return [];
  }
}

/**
 * Fetches active tasks assigned to a user from the tasks database.
 * @param {string} notionTaskAssigneeName - The name of the user as it appears in the "Assignee" field.
 * @returns {Promise<Array<Object>>} A list of task objects or an empty array.
 */
async function fetchActiveTasksForUser(staff) {
  logToFile(`[NotionUtils] fetchActiveTasksForUser called with staff: ${JSON.stringify(staff)}`);
  if (!notionUtilsClient) {
    logToFile('[NotionUtils] fetchActiveTasksForUser: notionUtilsClient is not initialized!');
    return [];
  }
  if (!staff || !staff.notionTaskAssigneeName) {
    logToFile('[NotionUtils] fetchActiveTasksForUser: Staff Notion task assignee name not provided or empty.');
    return [];
  }

  const databaseId = TASKS_DATABASE_ID;
  const filterConditions = [
    {
      property: "Assignee",
      select: {
        equals: staff.notionTaskAssigneeName,
      },
    },
    {
      property: "Status",
      status: {
        does_not_equal: "Done",
      },
    },
    {
      property: "Status",
      status: {
        does_not_equal: "Archived",
      },
    }
  ];
  
  const fullFilter = { and: filterConditions };
  logToFile(`[NotionUtils] Querying Tasks DB (${databaseId}) for ${staff.name} (Assignee: ${staff.notionTaskAssigneeName}). Filter: ${JSON.stringify(fullFilter)}`);

  try {
    const response = await notionUtilsClient.databases.query({
      database_id: databaseId,
      filter: fullFilter,
    });
    logToFile(`[NotionUtils] Tasks query for ${staff.name} (Assignee: ${staff.notionTaskAssigneeName}) returned ${response.results.length} results.`);
    if (response.results.length > 0) {
      logToFile(`[NotionUtils] First task raw data for ${staff.name}: ID: ${response.results[0].id}, Properties: ${JSON.stringify(response.results[0].properties)}`);
    }
    return response.results.map(page => ({
      id: page.id,
      name: page.properties["Task Name"]?.title[0]?.plain_text || page.properties["Name"]?.title[0]?.plain_text ||  page.properties.title?.title[0]?.plain_text || "Untitled Task",
    }));
  } catch (error) {
    logToFile(`[NotionUtils] Error fetching tasks for ${staff.name}: ${error.message}\nStack: ${error.stack}`);
    console.error(`[NotionUtils] Error fetching tasks for ${staff.name}:`, error);
    return [];
  }
}

module.exports = {
  fetchActiveProjectsForUser,
  fetchActiveTasksForUser,
  // getOpenAIClientForUtils, // If you decide to pass it
}; 
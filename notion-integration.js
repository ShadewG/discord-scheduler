/**
 * Notion Integration for Discord Scheduler Bot
 * 
 * This integration polls a Notion database every minute and checks for pages
 * where a specific property (e.g., "Caption Status") equals a specific value
 * (e.g., "Ready For Captions"). When it finds matching pages that have been
 * updated since the last check, it sends a Discord message mentioning the
 * specified user.
 * 
 * ## Prerequisites
 * 
 * 1. Create a Notion Integration:
 *    - Go to https://www.notion.so/my-integrations
 *    - Create a new integration
 *    - Copy the "Internal Integration Token" (starts with "secret_")
 * 
 * 2. Share your database with the integration:
 *    - Open your Notion database
 *    - Click "..." in the top right
 *    - Click "Add connections"
 *    - Find and select your integration
 * 
 * 3. Get your database ID:
 *    - Option 1: From the URL
 *      - Open your database in Notion
 *      - The URL will look like: https://www.notion.so/workspace/83c7a9f1b48e4c6b9edeb3e21e3cb49d?v=...
 *      - Copy the 32-character ID (83c7a9f1b48e4c6b9edeb3e21e3cb49d in this example)
 *    
 *    - Option 2: From the Share Link
 *      - Click "Share" button
 *      - Click "Copy link"
 *      - Find the UUID in the URL (pattern: 32 characters with or without hyphens)
 * 
 * 4. Configure environment variables:
 *    - NOTION_TOKEN: Your Notion integration token (secret_xxx...)
 *    - NOTION_DB_ID: Your database ID (with or without hyphens)
 * 
 * 5. Database requirements:
 *    - Must have a "Caption Status" property of type "Select"
 *    - Must have a "Name" property (title property)
 * 
 * ## Troubleshooting
 * 
 * 1. "object_not_found" error:
 *    - Verify your database ID is correct
 *    - Make sure you've shared the database with your integration
 *    - Check if your integration has the correct capabilities
 * 
 * 2. Property not found errors:
 *    - Make sure your database has a "Caption Status" property
 *    - Ensure the property is a "Select" type
 *    - Verify your database has a title property named "Name"
 * 
 * ## Configuration
 * 
 * In index.js, you can configure:
 * - TARGET_PROP: The name of the property/column to check (default: "Caption Status")
 * - TARGET_VALUE: The value that triggers a notification (default: "Ready For Captions")
 * - RAY_ID: The Discord user ID to mention in notifications
 */

// This file is for documentation only and is not loaded by the application 
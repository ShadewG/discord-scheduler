/**
 * Notion Integration for Discord Scheduler Bot
 * 
 * This integration polls a Notion database every minute and checks for pages
 * where a specific property (e.g., "Caption Status") equals a specific value
 * (e.g., "Ready For Captions"). When it finds matching pages that have been
 * updated since the bot started running, it sends a Discord message mentioning 
 * the specified user.
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
 *    - Must have a title property (any of these names will work: "Project Name", "Name", "Title", "Page", "Project")
 *    - Should have one or more "Select" type properties to watch for changes
 * 
 * ## Features
 * 
 * 1. Flexible Title Property:
 *    - The integration will automatically find the title property
 *    - It tries common names first: "Project Name", "Name", "Title", "Page", "Project"
 *    - If none of these match, it will find any property of type "title"
 * 
 * 2. Separate Notification Channel:
 *    - Notion notifications go to a dedicated channel (1364886978851508224)
 *    - Regular scheduler reminders use the standard channel
 * 
 * 3. Prevents Duplicate Notifications:
 *    - The integration tracks which pages it has already processed
 *    - Once a notification is sent for a page, it won't notify again for that same page
 * 
 * 4. Only Tracks New Changes:
 *    - The bot only processes pages that were marked with specific statuses after the bot started
 *    - Any pages that were already in that state before the bot started will be ignored
 *    - This prevents a flood of notifications for pre-existing content when restarting the bot
 * 
 * 5. Custom Status Watchers:
 *    - Create custom watchers for any property and value combinations
 *    - Each watcher can notify a different user
 *    - Watchers can be enabled, disabled, or deleted
 *    - Changes are only tracked from when the bot starts
 * 
 * ## Using Custom Watchers
 * 
 * 1. Viewing available properties:
 *    - Use `/notion properties` to see all properties in your database
 *    - Note which ones are of type "select" as these can be watched
 * 
 * 2. Creating a watcher:
 *    - Use `/notion add` to create a new watcher
 *    - Provide a name, property to watch, value to look for, and user to notify
 *    - Example: `/notion add name:Design Review property:Status value:Ready for Review user:@Designer`
 * 
 * 3. Managing watchers:
 *    - `/notion list` - See all configured watchers
 *    - `/notion enable [id]` - Enable a watcher by ID
 *    - `/notion disable [id]` - Temporarily disable a watcher
 *    - `/notion delete [id]` - Permanently delete a watcher
 * 
 * ## Troubleshooting
 * 
 * 1. "object_not_found" error:
 *    - Verify your database ID is correct
 *    - Make sure you've shared the database with your integration
 *    - Check if your integration has the correct capabilities
 * 
 * 2. Property not found errors:
 *    - Make sure your database has the properties you're trying to watch
 *    - Ensure the properties are "Select" type
 *    - Ensure your database has at least one title-type property
 * 
 * ## Configuration
 * 
 * In index.js, you can configure:
 * - TARGET_PROP: The name of the default property to check (default: "Caption Status")
 * - TARGET_VALUE: The value that triggers the default notification (default: "Ready For Captions")
 * - RAY_ID: The Discord user ID to mention in default notifications
 * - NOTION_CHANNEL_ID: Channel where Notion notifications are sent
 * 
 * Custom watchers are stored in notion-watchers.json
 */

// This file is for documentation only and is not loaded by the application 
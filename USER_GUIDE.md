# Insanity Discord Bot User Guide

This guide provides a comprehensive overview of all the commands available in the Insanity Discord Bot, designed to help manage projects, track Notion databases, schedule meetings, and more.

## Table of Contents
- [Getting Started](#getting-started)
- [Basic Commands](#basic-commands)
- [Notion Integration Commands](#notion-integration-commands)
- [Meeting and Schedule Commands](#meeting-and-schedule-commands)
- [Utility Commands](#utility-commands)
- [Tips and Troubleshooting](#tips-and-troubleshooting)

## Getting Started

The Insanity Discord Bot uses slash commands, which means all commands start with a forward slash (`/`) followed by the command name. To use any command, simply type `/` in Discord and you'll see a list of available commands.

## Basic Commands

### `/add`
Add a new scheduled reminder to the channel.
- **Usage**: `/add time:[time] message:[message]`
- **Example**: `/add time:every day at 9am message:Good morning team! Daily standup in 30 minutes.`
- **Parameters**:
  - `time` (required): When the reminder should trigger (e.g., "every day at 9am", "every Monday at 2pm")
  - `message` (required): The message to send when the reminder triggers

### `/list`
List all scheduled reminders in the current channel.
- **Usage**: `/list`
- **Example**: `/list`

### `/edit`
Edit an existing scheduled reminder.
- **Usage**: `/edit id:[reminder_id] time:[new_time] message:[new_message]`
- **Example**: `/edit id:daily-standup time:every day at 9:30am`
- **Parameters**:
  - `id` (required): The ID of the reminder to edit (get this from `/list`)
  - `time` (optional): The new time for the reminder
  - `message` (optional): The new message for the reminder

### `/status`
Check the bot's status and configuration.
- **Usage**: `/status`
- **Example**: `/status`

### `/help`
Show help information about the bot commands.
- **Usage**: `/help`
- **Example**: `/help`

### `/test`
Send test messages for all scheduled reminders to verify they're working.
- **Usage**: `/test`
- **Example**: `/test`

## Notion Integration Commands

### `/where`
Find project information from Notion by project code or name.
- **Usage**: `/where query:[search_term] ephemeral:[true/false]`
- **Example**: `/where query:IB23 ephemeral:true`
- **Parameters**:
  - `query` (required): Project code (e.g., "IB23") or name to search for
  - `ephemeral` (optional): Set to `true` to make the response only visible to you

This command will display:
- Project name and code
- Notion card link
- Discord channels related to the project
- Frame.io link (if available)
- Project status
- Due date
- Script link (from Notion or Discord)
- Lead and editor information

### `/link`
Get the Notion link for the current project.
- **Usage**: `/link ephemeral:[true/false]`
- **Example**: `/link ephemeral:true`
- **Parameters**:
  - `ephemeral` (optional): Set to `true` to make the response only visible to you

### `/availability`
Show a live time board of who is currently working.
- **Usage**: `/availability ephemeral:[true/false]`
- **Example**: `/availability ephemeral:false`
- **Parameters**:
  - `ephemeral` (optional): Set to `true` to make the response only visible to you

This command shows:
- Current time in Berlin
- Staff currently working (with time left in their shift)
- Staff not currently working (with their working hours)

### `/sync`
Update Notion with properties from your message.
- **Usage**: `/sync text:[properties] dry_run:[true/false]`
- **Example**: `/sync text:Status: Ready for Editing, Due Date: Friday dry_run:true`
- **Parameters**:
  - `text` (required): The properties to update in the format "Property: Value"
  - `dry_run` (optional): Set to `true` to preview changes without updating Notion

### `/analyze`
Analyze channel messages and update Notion based on the content.
- **Usage**: `/analyze messages:[count] dry_run:[true/false] ephemeral:[true/false]`
- **Example**: `/analyze messages:200 dry_run:true ephemeral:true`
- **Parameters**:
  - `messages` (optional): Number of messages to analyze (default: 100)
  - `dry_run` (optional): Set to `true` to preview changes without updating Notion
  - `ephemeral` (optional): Set to `true` to make the response only visible to you

### `/set status`
Set the Status property on the Notion page for the current channel.
- **Usage**: `/set status value:[status]`
- **Example**: `/set status value:Ready for Editing`
- **Parameters**:
  - `value` (required): Status value (choices include: Writing, Writing Review, VA Render, Ready for Editing, Clip Selection, MGX, Pause)

### `/notion add`
Add a new Notion watcher to notify when properties change.
- **Usage**: `/notion add property:[property] value:[value]`
- **Example**: `/notion add property:Status value:Ready for Editing`
- **Parameters**:
  - `property` (required): Property to watch (e.g., "Status")
  - `value` (required): Value to watch for (e.g., "Ready for Editing")

### `/watch`
Create a Notion watcher to notify when properties change.
- **Usage**: `/watch property:[property] value:[value]`
- **Example**: `/watch property:Status value:Ready for Editing`
- **Parameters**:
  - `property` (required): Property to watch (e.g., "Status")
  - `value` (required): Value to watch for (e.g., "Ready for Editing")

### `/watchers`
List all active Notion watchers in detail.
- **Usage**: `/watchers`
- **Example**: `/watchers`

## Meeting and Schedule Commands

### `/schedule`
Show the weekly schedule of reminders.
- **Usage**: `/schedule`
- **Example**: `/schedule`
- The bot also posts automatic deadline reminders in project channels a few days before each due date.

### `/meeting`
Schedule a meeting with reminders.
- **Usage**: `/meeting title:[title] time:[time] description:[description] remind:[true/false]`
- **Example**: `/meeting title:Weekly Review time:tomorrow at 3pm description:Review progress for IB23 remind:true`
- **Parameters**:
  - `title` (required): Meeting title
  - `time` (required): Meeting time (e.g., "tomorrow at 3pm", "Friday at 2pm")
  - `description` (optional): Meeting description
  - `remind` (optional): Set to `true` to send a reminder 5 minutes before the meeting

## Utility Commands

### `/dashboard`
Show a project dashboard with key metrics and status.
- **Usage**: `/dashboard ephemeral:[true/false]`
- **Example**: `/dashboard ephemeral:true`
- **Parameters**:
  - `ephemeral` (optional): Set to `true` to make the response only visible to you

### `/timeline`
Generate a visual timeline of project milestones.
- **Usage**: `/timeline timeframe:[week/month/quarter] ephemeral:[true/false]`
- **Example**: `/timeline timeframe:month ephemeral:false`
- **Parameters**:
  - `timeframe` (optional): Timeframe to display (choices: week, month, quarter)
  - `ephemeral` (optional): Set to `true` to make the response only visible to you

### `/export`
Export project data to a file.
- **Usage**: `/export format:[csv/json/txt] include_history:[true/false]`
- **Example**: `/export format:csv include_history:true`
- **Parameters**:
  - `format` (required): Export format (choices: csv, json, txt)
  - `include_history` (optional): Set to `true` to include historical data

### `/summary`
Generate an AI summary of recent project activity.
- **Usage**: `/summary days:[number] ephemeral:[true/false]`
- **Example**: `/summary days:14 ephemeral:true`
- **Parameters**:
  - `days` (optional): Number of days to summarize (default: 7)
  - `ephemeral` (optional): Set to `true` to make the response only visible to you

## Tips and Troubleshooting

### Finding Project Information
The `/where` command is the most powerful way to find information about a project. You can search by:
- Project code (e.g., "IB23", "CL45")
- Project name (e.g., "Insanity Breakdown")

The command will show you all relevant information including:
- Links to Notion, Frame.io, and the script
- Current status and due date
- Team members working on the project
- Related Discord channels

### Setting Up Reminders
Use the `/add` command to set up recurring reminders for:
- Daily standups
- Weekly meetings
- Deadline notifications

### Notion Integration Issues
If you see an error message about Notion integration not being configured:
1. Make sure the bot has the correct environment variables set up on Railway
2. Ensure the Notion integration has access to your database
3. Check that your Notion database has the expected property names

### Command Visibility
Many commands have an `ephemeral` option that determines whether the response is visible to everyone or just you:
- `ephemeral:true` - Only you can see the response
- `ephemeral:false` - Everyone in the channel can see the response

### Image Generation
Use `/create` to generate an image with the RED-MONOLITH style.

```
/create prompt:[description] [image:reference]
```

After the bot sends the image, reply to that image with a new prompt to produce an edited version. The bot keeps track of the previous image automatically.

### Getting Help
If you're unsure about how to use a command, you can:
1. Type `/help` to see general help information
2. Start typing a command (e.g., `/where`) and Discord will show you the available options
3. Ask a team administrator for assistance

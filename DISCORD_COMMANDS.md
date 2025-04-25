# Discord Bot Commands and Persistence

## Discord Slash Commands

If Discord slash commands aren't showing up in the autocomplete, you may need to re-register them with Discord. There are two ways to fix this:

### Option 1: Using the included script

Run the following command in your terminal to register all commands:

```bash
node register-commands.js
```

**Note:** You may need to set your `CLIENT_ID` in the `.env` file or directly in the script.

### Option 2: Using the bot's `/register` command

If you have administrator permissions on the server, you can use the `/register` command to re-register all slash commands for the current server.

## Persisting Data Between Deployments

The bot stores various data locally, including Notion watchers, which can be lost between deployments when using services like Railway.

### Using Git to Persist Watchers

To persist watchers between deployments, run the helper script:

```bash
node update_watchers.js
```

This will:
1. Create or update the `notion-watchers.json` file
2. Commit it to your git repository

Once you've run this script, make sure to:
1. Push the changes to your GitHub repository
2. When deploying on Railway or similar services, the watchers file will be included in your repository

### Manual Solution

If you prefer a manual approach:
1. Backup your existing watchers with `/notion list`
2. Edit `notion-watchers.json` to include your watchers
3. Commit and push the changes to your repository
4. Deploy from the updated repository

## Available Commands

### Notion Integration Commands

- `/sync` - Update Notion with details from your message (now ephemeral)
- `/analyze` - Analyze channel messages and update Notion automatically
- `/link` - Get the Notion link for the current project
- `/set` - Set a specific property on the Notion page for this channel
- `/notion` - Manage Notion status watchers
- `/watchers` - List all Notion watchers in detail 
# Discord Command Troubleshooting

This guide will help you fix issues with Discord slash commands not appearing in the autofill.

## Common Issues

1. **Command Registration Delay**: Global commands can take up to an hour to propagate to all Discord servers.
2. **Registration Failure**: Commands might not be registering correctly due to API errors.
3. **Permission Issues**: The bot might not have the right permissions to register commands.

## Quick Fix

Run the following command to force re-register all commands:

```bash
node fix-commands.js
```

This script will:
1. Register commands globally (takes up to an hour to propagate)
2. Register commands to the first 5 guilds the bot is in (immediate availability)
3. Create a detailed log file (`command-registration.log`) for debugging

## Manual Registration

If you want to manually register commands:

```bash
node register-commands.js
```

## Checking Command Status

You can check if your commands are registered in the Discord Developer Portal:

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application
3. Go to "Bot" > "OAuth2" > "URL Generator"
4. Select "applications.commands" scope
5. Check if your commands are listed

## Railway Deployment

When deploying to Railway, the bot should automatically register commands on startup. If this isn't working:

1. Check the Railway logs for any errors
2. Make sure your bot has the right permissions
3. Try manually running the `fix-commands.js` script

## Troubleshooting Steps

If commands still don't appear:

1. Check if the bot has the `applications.commands` scope in its OAuth2 URL
2. Verify that the bot has the right permissions in the server
3. Try removing and re-adding the bot to the server
4. Check if the command is defined correctly in both `register-commands.js` and `index.js`

## Need More Help?

If you're still having issues, check the `command-registration.log` file for detailed error messages.

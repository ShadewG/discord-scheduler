# Deployment Guide

This guide provides instructions for deploying the Discord Scheduler Bot on various cloud platforms.

## Prerequisites

Before deploying, make sure you have:
1. Created a Discord bot and obtained the token
2. Invited the bot to your server
3. Set up the necessary environment variables

## Option 1: Deploy on Railway

1. Sign up at [Railway](https://railway.app/)
2. Create a new project from GitHub repository
3. Connect your repository
4. Add environment variables in the Railway dashboard:
   - `DISCORD_TOKEN`
   - `CHANNEL_ID`
   - `ROLE_ID`
   - `TIMEZONE`
5. Deploy the project

## Option 2: Deploy on Repl.it

1. Sign up at [Repl.it](https://replit.com/)
2. Create a new Repl and select "Import from GitHub"
3. Set up environment variables in the Secrets tab:
   - `DISCORD_TOKEN`
   - `CHANNEL_ID`
   - `ROLE_ID`
   - `TIMEZONE`
4. Use the "Run" button to start your bot
5. Set up Repl.it's "Always On" feature to keep your bot running

## Option 3: Deploy on Render

1. Sign up at [Render](https://render.com/)
2. Create a new Web Service
3. Connect your GitHub repository
4. Set the build command to `npm install`
5. Set the start command to `npm start`
6. Add environment variables:
   - `DISCORD_TOKEN`
   - `CHANNEL_ID`
   - `ROLE_ID`
   - `TIMEZONE`
7. Deploy the service

## Option 4: Deploy on Fly.io

1. Install the Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Authenticate: `fly auth login`
3. Create a new app: `fly launch`
4. Set secrets:
   ```
   fly secrets set DISCORD_TOKEN=your_token_here
   fly secrets set CHANNEL_ID=your_channel_id
   fly secrets set ROLE_ID=your_role_id
   fly secrets set TIMEZONE=Europe/Berlin
   ```
5. Deploy: `fly deploy`

## Option 5: Run Locally with PM2

PM2 is a process manager for Node.js applications that keeps your bot running.

1. Install PM2 globally: `npm install -g pm2`
2. Start your bot with PM2: `pm2 start index.js --name discord-scheduler`
3. Configure PM2 to start on system boot: `pm2 startup`
4. Save the current process list: `pm2 save`

## Checking Logs

### Railway
- View logs in the Railway dashboard

### Repl.it
- View logs in the Console tab

### Render
- View logs in the Render dashboard

### Fly.io
- View logs with `fly logs`

### PM2
- View logs with `pm2 logs discord-scheduler` 
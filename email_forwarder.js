// email_forwarder.js - handle incoming email webhooks and forward to Discord

const express = require('express');
const { logToFile } = require('./log_utils');

/**
 * Initialize email forwarding endpoint
 * @param {express.Express} app - Express app to attach the route to
 * @param {import('discord.js').Client} client - Discord client used to send messages
 * @param {string} channelId - ID of the Discord channel to forward emails to
 */
function initEmailForwarder(app, client, channelId) {
  if (!app || !client || !channelId) {
    logToFile('Email forwarder not initialized - missing parameters');
    return;
  }

  app.use(express.json({ limit: '10mb' }));

  app.post('/incoming-email', async (req, res) => {
    const { from, subject, text } = req.body;
    if (!from || !subject || !text) {
      res.status(400).send('Missing required fields');
      return;
    }

    try {
      const channel = await client.channels.fetch(channelId);
      const message = `**Email from ${from}**\n**Subject:** ${subject}\n\n${text}`;
      await channel.send(message);
      res.status(200).send('ok');
    } catch (error) {
      logToFile(`Error forwarding email: ${error.message}`);
      res.status(500).send('error');
    }
  });

  logToFile('Email forwarder initialized');
}

module.exports = { initEmailForwarder };

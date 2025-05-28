const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');
const fs = require('fs').promises;
const path = require('path');
const { logToFile } = require('./log_utils');

class GmailPoller {
  constructor(client, channelId, credsPath, tokenPath) {
    this.client = client;
    this.channelId = channelId;
    this.credsPath = credsPath || path.join(process.cwd(), 'credentials.json');
    this.tokenPath = tokenPath || path.join(process.cwd(), 'token.json');
    this.gmail = null;
    this.lastCheckedHistoryId = null;
  }

  async initialize() {
    try {
      const auth = await this.authenticate();
      this.gmail = google.gmail({ version: 'v1', auth });
      const profile = await this.gmail.users.getProfile({ userId: 'me' });
      this.lastCheckedHistoryId = profile.data.historyId;
      logToFile('Gmail polling initialized');
    } catch (error) {
      logToFile(`Error initializing Gmail poller: ${error.message}`);
      throw error;
    }
  }

  async authenticate() {
    const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
    try {
      const token = await fs.readFile(this.tokenPath);
      const credentials = await fs.readFile(this.credsPath);
      const { client_secret, client_id, redirect_uris } = JSON.parse(credentials).installed;
      const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
      oAuth2Client.setCredentials(JSON.parse(token));
      return oAuth2Client;
    } catch (error) {
      const auth = await authenticate({ scopes: SCOPES, keyfilePath: this.credsPath });
      await fs.writeFile(this.tokenPath, JSON.stringify(auth.credentials));
      return auth;
    }
  }

  async checkForNewEmails() {
    try {
      const history = await this.gmail.users.history.list({
        userId: 'me',
        startHistoryId: this.lastCheckedHistoryId,
      });
      if (!history.data.history) {
        return;
      }
      const messageIds = new Set();
      for (const item of history.data.history) {
        if (item.messagesAdded) {
          item.messagesAdded.forEach(m => messageIds.add(m.message.id));
        }
      }
      for (const id of messageIds) {
        await this.processMessage(id);
      }
      if (history.data.historyId) {
        this.lastCheckedHistoryId = history.data.historyId;
      }
    } catch (error) {
      logToFile(`Error checking emails: ${error.message}`);
    }
  }

  async processMessage(messageId) {
    try {
      const message = await this.gmail.users.messages.get({ userId: 'me', id: messageId });
      const headers = message.data.payload.headers;
      const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
      const body = this.extractBody(message.data.payload);
      await this.sendToDiscord(from, subject, body);
    } catch (error) {
      logToFile(`Error processing Gmail message: ${error.message}`);
    }
  }

  extractBody(payload) {
    let body = '';
    if (payload.body && payload.body.data) {
      body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    } else if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body && part.body.data) {
          body = Buffer.from(part.body.data, 'base64').toString('utf-8');
          break;
        }
      }
    }
    if (body.length > 1900) {
      body = body.substring(0, 1900) + '...';
    }
    return body || 'No text content';
  }

  async sendToDiscord(from, subject, text) {
    try {
      const channel = await this.client.channels.fetch(this.channelId);
      const embed = {
        color: 0x0099ff,
        title: '📧 New Email',
        fields: [
          { name: 'From', value: from, inline: true },
          { name: 'Subject', value: subject || 'No Subject', inline: true },
          { name: 'Content', value: text || 'No content' },
        ],
        timestamp: new Date(),
      };
      await channel.send({ embeds: [embed] });
    } catch (error) {
      logToFile(`Error sending email to Discord: ${error.message}`);
    }
  }

  startPolling(intervalMinutes = 5) {
    this.checkForNewEmails();
    setInterval(() => this.checkForNewEmails(), intervalMinutes * 60 * 1000);
    logToFile(`Gmail polling started - checking every ${intervalMinutes} minutes`);
  }
}

module.exports = GmailPoller;

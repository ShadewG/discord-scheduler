const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'points.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { users: {}, transactions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to load points data:', err);
    return { users: {}, transactions: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getUser(id) {
  const data = loadData();
  if (!data.users[id]) {
    data.users[id] = { creds: 0, xp: 0, level: 0 };
    saveData(data);
  }
  return data.users[id];
}

function getLevel(xp) {
  return Math.floor(xp / 500);
}

function addCreds(id, amount, reason) {
  const data = loadData();
  const user = data.users[id] || { creds: 0, xp: 0, level: 0 };
  user.creds += amount;
  user.xp += amount;
  user.level = getLevel(user.xp);
  data.users[id] = user;
  data.transactions.push({ userId: id, timestamp: new Date().toISOString(), type: 'earn', amount, reason });
  saveData(data);
  return user;
}

function spendCreds(id, amount, reason) {
  const data = loadData();
  const user = data.users[id] || { creds: 0, xp: 0, level: 0 };
  if (user.creds < amount) return false;
  user.creds -= amount;
  data.users[id] = user;
  data.transactions.push({ userId: id, timestamp: new Date().toISOString(), type: 'spend', amount: -amount, reason });
  saveData(data);
  return true;
}

function getBalance(id) {
  const user = getUser(id);
  return { creds: user.creds, xp: user.xp, level: user.level };
}

module.exports = {
  addCreds,
  spendCreds,
  getBalance,
};

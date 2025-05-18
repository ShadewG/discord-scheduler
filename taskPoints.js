const path = require('path');
const { readJsonFile, writeJsonFile } = require('./utils');

const TASKS_FILE = path.join(__dirname, 'tasks.json');

let tasks = readJsonFile(TASKS_FILE, []);

function save() {
  writeJsonFile(TASKS_FILE, tasks);
}

function addTask({ id, userId, description, points = 0, completed = false }) {
  tasks.push({ id, userId, description, points, completed });
  save();
}

function getTasks() {
  return tasks;
}

function updateTask(id, updates = {}) {
  const task = tasks.find(t => t.id === id);
  if (task) {
    Object.assign(task, updates);
    save();
  }
  return task;
}

module.exports = { addTask, getTasks, updateTask };

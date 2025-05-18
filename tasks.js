const path = require('path');
const { readJsonFile, writeJsonFile, logToFile } = require('./utils');

const TASKS_FILE = path.join(__dirname, 'tasks.json');

function loadTasks() {
  return readJsonFile(TASKS_FILE, []);
}

function saveTasks(tasks) {
  return writeJsonFile(TASKS_FILE, tasks);
}

function addTask(task) {
  const tasks = loadTasks();
  tasks.push(task);
  saveTasks(tasks);
  logToFile(`[Tasks] Added task ${task.id}`);
}

module.exports = {
  TASKS_FILE,
  loadTasks,
  saveTasks,
  addTask
};

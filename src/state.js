/**
 * State Management
 * Handles persistence of temperature highs and registered users via JSON files
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Get the path for a location's state file for a specific date
 */
function getStateFilePath(locationId, date) {
  return path.join(DATA_DIR, `${locationId}_${date}.json`);
}

/**
 * Get users file path
 */
function getUsersFilePath() {
  return path.join(DATA_DIR, 'users.json');
}

/**
 * Load state for a specific location and date
 * Returns: { highTemp: number|null, hasAlertedDrop: boolean, lastTemp: number|null }
 */
export function loadLocationState(locationId, date) {
  const filePath = getStateFilePath(locationId, date);
  
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return data;
    } catch (err) {
      console.error(`Error reading state for ${locationId}:`, err.message);
    }
  }
  
  // Default state for new day
  return {
    highTemp: null,
    hasAlertedDrop: false,
    lastTemp: null,
    history: []
  };
}

/**
 * Save state for a specific location and date
 */
export function saveLocationState(locationId, date, state) {
  const filePath = getStateFilePath(locationId, date);
  
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`Error saving state for ${locationId}:`, err.message);
  }
}

/**
 * Clean up old state files (files older than 2 days)
 */
export function cleanupOldStateFiles() {
  const files = fs.readdirSync(DATA_DIR);
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  
  files.forEach(file => {
    // Skip users.json
    if (file === 'users.json') return;
    
    // Extract date from filename (format: locationId_YYYY-MM-DD.json)
    const match = file.match(/_(\d{4}-\d{2}-\d{2})\.json$/);
    if (match) {
      const fileDate = new Date(match[1]);
      if (fileDate < twoDaysAgo) {
        const filePath = path.join(DATA_DIR, file);
        fs.unlinkSync(filePath);
        console.log(`🗑️ Cleaned up old state file: ${file}`);
      }
    }
  });
}

/**
 * Load registered Telegram users
 */
export function loadUsers() {
  const filePath = getUsersFilePath();
  
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error('Error reading users:', err.message);
    }
  }
  
  return [];
}

/**
 * Save registered Telegram users
 */
export function saveUsers(users) {
  const filePath = getUsersFilePath();
  
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error('Error saving users:', err.message);
  }
}

/**
 * Add a user if not already registered
 * By default, all markets are enabled
 */
export function addUser(chatId, username = null, defaultMarkets = []) {
  const users = loadUsers();
  
  if (!users.find(u => u.chatId === chatId)) {
    // Enable all markets by default
    const enabledMarkets = {};
    defaultMarkets.forEach(m => { enabledMarkets[m] = true; });
    
    users.push({
      chatId,
      username,
      registeredAt: new Date().toISOString(),
      enabledMarkets
    });
    saveUsers(users);
    return true; // New user
  }
  
  return false; // Already registered
}

/**
 * Get a user by chat ID
 */
export function getUser(chatId) {
  const users = loadUsers();
  return users.find(u => u.chatId === chatId) || null;
}

/**
 * Update user's market preferences
 */
export function updateUserMarkets(chatId, enabledMarkets) {
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.chatId === chatId);
  
  if (userIndex !== -1) {
    users[userIndex].enabledMarkets = enabledMarkets;
    saveUsers(users);
    return true;
  }
  
  return false;
}

/**
 * Toggle a specific market for a user
 */
export function toggleUserMarket(chatId, marketId) {
  const users = loadUsers();
  const userIndex = users.findIndex(u => u.chatId === chatId);
  
  if (userIndex !== -1) {
    const user = users[userIndex];
    if (!user.enabledMarkets) {
      user.enabledMarkets = {};
    }
    
    // Toggle the market
    user.enabledMarkets[marketId] = !user.enabledMarkets[marketId];
    saveUsers(users);
    
    return user.enabledMarkets[marketId];
  }
  
  return null;
}

/**
 * Check if a user has a specific market enabled
 */
export function isMarketEnabled(chatId, marketId) {
  const user = getUser(chatId);
  if (!user) return false;
  
  // If enabledMarkets doesn't exist or market not set, default to true (legacy users)
  if (!user.enabledMarkets) return true;
  if (user.enabledMarkets[marketId] === undefined) return true;
  
  return user.enabledMarkets[marketId];
}

/**
 * Get users who have a specific market enabled
 */
export function getUsersForMarket(marketId) {
  const users = loadUsers();
  return users.filter(user => {
    // Legacy users without enabledMarkets get all notifications
    if (!user.enabledMarkets) return true;
    if (user.enabledMarkets[marketId] === undefined) return true;
    return user.enabledMarkets[marketId];
  });
}

/**
 * Remove a user
 */
export function removeUser(chatId) {
  const users = loadUsers();
  const filtered = users.filter(u => u.chatId !== chatId);
  
  if (filtered.length !== users.length) {
    saveUsers(filtered);
    return true;
  }
  
  return false;
}


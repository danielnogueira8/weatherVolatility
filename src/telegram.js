/**
 * Telegram Bot Module
 * Handles bot initialization, user registration, and message broadcasting
 */

import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config/telegram.js';
import { addUser, removeUser, loadUsers, getUser, toggleUserMarket, getUsersForMarket } from './state.js';
import { locations } from '../config/locations.js';
import { getAllAttentionZonesWithLisbon, fetchWeatherData, extractCurrentTemp, getLocalTime } from './weather.js';

let bot = null;

// Track active tracking sessions
// Format: { chatId: { locationId: { messageId, lastTemp, lastUpdateTime } } }
const activeTrackings = new Map();

// Track intervals for cleanup
const trackingIntervals = new Map();

/**
 * Generate inline keyboard for market toggles
 */
function getMarketsKeyboard(chatId) {
  const user = getUser(chatId);
  
  const keyboard = locations.map(loc => {
    // Check if market is enabled (default true for legacy/new users)
    let isEnabled = true;
    if (user?.enabledMarkets && user.enabledMarkets[loc.id] !== undefined) {
      isEnabled = user.enabledMarkets[loc.id];
    }
    
    const statusIcon = isEnabled ? '✅' : '❌';
    
    return [{
      text: `${statusIcon} ${loc.emoji} ${loc.name}`,
      callback_data: `toggle_${loc.id}`
    }];
  });
  
  return { inline_keyboard: keyboard };
}

/**
 * Initialize the Telegram bot
 */
export function initBot() {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  
  // Handle /start command
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from?.username || msg.from?.first_name || 'User';
    
    // Get all location IDs for default enabled markets
    const defaultMarkets = locations.map(l => l.id);
    const isNew = addUser(chatId, username, defaultMarkets);
    
    if (isNew) {
      bot.sendMessage(chatId, 
        `🌡️ *Weather Volatility Alerts*\n\n` +
        `Welcome, ${username}! You're now subscribed to temperature alerts.\n\n` +
        `📍 *Monitored Locations:*\n` +
        locations.map(l => `${l.emoji} ${l.name}`).join('\n') +
        `\n\n` +
        `You'll receive alerts when:\n` +
        `📈 A new high temperature is recorded\n` +
        `📉 Temperature drops from the day's high\n\n` +
        `*Commands:*\n` +
        `/markets - Enable/disable market alerts\n` +
        `/status - View current temperatures\n` +
        `/timezone - Peak hours in Lisbon time\n` +
        `/track [city] - Track a market (updates every 10s)\n` +
        `/untrackall - Stop all tracking\n` +
        `/stop - Unsubscribe from alerts`,
        { parse_mode: 'Markdown' }
      );
      console.log(`✅ New user registered: ${username} (${chatId})`);
    } else {
      bot.sendMessage(chatId, 
        `👋 You're already subscribed to weather alerts!\n\n` +
        `Use /markets to manage alerts, /status to view temperatures, or /stop to unsubscribe.`
      );
    }
  });
  
  // Handle /markets command
  bot.onText(/\/markets/, (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(chatId);
    
    if (!user) {
      bot.sendMessage(chatId, 
        `❌ You're not subscribed yet. Use /start first!`
      );
      return;
    }
    
    bot.sendMessage(chatId, 
      `🌍 *Market Notifications*\n\n` +
      `Tap a market to toggle alerts on/off:\n` +
      `✅ = Enabled  ❌ = Disabled`,
      { 
        parse_mode: 'Markdown',
        reply_markup: getMarketsKeyboard(chatId)
      }
    );
  });
  
  // Handle callback queries (button presses)
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    
    // Handle market toggle
    if (data.startsWith('toggle_')) {
      const marketId = data.replace('toggle_', '');
      const location = locations.find(l => l.id === marketId);
      
      if (location) {
        const newState = toggleUserMarket(chatId, marketId);
        const stateText = newState ? 'enabled ✅' : 'disabled ❌';
        
        // Update the keyboard
        await bot.editMessageReplyMarkup(getMarketsKeyboard(chatId), {
          chat_id: chatId,
          message_id: messageId
        });
        
        // Answer the callback
        await bot.answerCallbackQuery(query.id, {
          text: `${location.emoji} ${location.name} alerts ${stateText}`,
          show_alert: false
        });
        
        console.log(`🔔 User ${chatId} toggled ${location.name}: ${stateText}`);
      }
    }
  });
  
  // Handle /stop command
  bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    const removed = removeUser(chatId);
    
    if (removed) {
      bot.sendMessage(chatId, 
        `👋 You've been unsubscribed from weather alerts.\n\n` +
        `Use /start anytime to resubscribe!`
      );
      console.log(`🚫 User unsubscribed: ${chatId}`);
    } else {
      bot.sendMessage(chatId, 
        `You weren't subscribed. Use /start to subscribe!`
      );
    }
  });
  
  // Handle /status command - will be implemented by weather module
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    // This will be handled by the weather module
    if (bot.statusHandler) {
      await bot.statusHandler(chatId);
    } else {
      bot.sendMessage(chatId, '⏳ Weather monitoring is starting up...');
    }
  });
  
  // Handle /timezone command - show dynamic attention zones in Lisbon time
  bot.onText(/\/timezone/, (msg) => {
    const chatId = msg.chat.id;
    
    const zones = getAllAttentionZonesWithLisbon();
    
    let zonesList = '';
    for (const loc of locations) {
      const zone = zones[loc.id];
      const lisbonTime = zone?.lisbonDisplay || 'Calculating...';
      const localTime = zone?.display || 'Calculating...';
      const avgSustained = zone?.avgSustainedCount || 'N/A';
      zonesList += `${loc.emoji} *${loc.name}*\n` +
                   `   🇵🇹 Lisbon: *${lisbonTime}*\n` +
                   `   📍 Local: ${localTime}\n` +
                   `   📊 Avg sustained: *${avgSustained} readings*\n\n`;
    }
    
    const message = 
      `🎯 *Attention Zones (Lisbon Time)*\n\n` +
      `_Based on last 7 days of historical data_\n` +
      `_When each market typically hits daily high_\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${zonesList}` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `_🚨 Alerts during these windows have special formatting_\n` +
      `_📊 Avg sustained = avg consecutive readings at ATH before drop_\n` +
      `_⏰ Primary times shown in Lisbon (UTC+0)_`;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  });
  
  // Handle /track command - start tracking a market
  bot.onText(/\/track\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const cityName = match[1].trim();
    
    // Find location by name (case-insensitive, partial match)
    const location = locations.find(loc => 
      loc.name.toLowerCase().includes(cityName.toLowerCase()) ||
      cityName.toLowerCase().includes(loc.name.toLowerCase())
    );
    
    if (!location) {
      const availableCities = locations.map(l => l.name).join(', ');
      await bot.sendMessage(chatId, 
        `❌ City "${cityName}" not found.\n\n` +
        `Available cities: ${availableCities}\n\n` +
        `Usage: /track London`
      );
      return;
    }
    
    // Check if already tracking
    if (!activeTrackings.has(chatId)) {
      activeTrackings.set(chatId, new Map());
    }
    
    const userTrackings = activeTrackings.get(chatId);
    
    if (userTrackings.has(location.id)) {
      await bot.sendMessage(chatId, 
        `⚠️ Already tracking ${location.emoji} ${location.name}.\n\n` +
        `Use /untrack ${location.name} to stop.`
      );
      return;
    }
    
    // Send initial tracking message
    const initialMessage = await bot.sendMessage(chatId,
      `🔍 *Tracking ${location.emoji} ${location.name}*\n\n` +
      `⏳ Fetching initial data...\n` +
      `_Last check: --_`,
      { parse_mode: 'Markdown' }
    );
    
    // Store tracking info
    userTrackings.set(location.id, {
      messageId: initialMessage.message_id,
      lastTemp: null,
      lastUpdateTime: null
    });
    
    // Start tracking loop
    startTracking(chatId, location.id, location);
    
    console.log(`🔍 User ${chatId} started tracking ${location.name}`);
  });
  
  // Handle /untrack command - stop tracking a market
  bot.onText(/\/untrack\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const cityName = match[1].trim();
    
    const location = locations.find(loc => 
      loc.name.toLowerCase().includes(cityName.toLowerCase()) ||
      cityName.toLowerCase().includes(loc.name.toLowerCase())
    );
    
    if (!location) {
      await bot.sendMessage(chatId, `❌ City "${cityName}" not found.`);
      return;
    }
    
    stopTracking(chatId, location.id);
    await bot.sendMessage(chatId, 
      `✅ Stopped tracking ${location.emoji} ${location.name}.`
    );
  });
  
  // Handle /untrackall command - stop all tracking
  bot.onText(/\/untrackall/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (activeTrackings.has(chatId)) {
      const userTrackings = activeTrackings.get(chatId);
      for (const locationId of userTrackings.keys()) {
        stopTracking(chatId, locationId);
      }
      activeTrackings.delete(chatId);
    }
    
    await bot.sendMessage(chatId, `✅ Stopped tracking all markets.`);
  });
  
  // Set up the bot command menu (blue button)
  bot.setMyCommands([
    { command: 'start', description: '🚀 Subscribe to weather alerts' },
    { command: 'markets', description: '🌍 Enable/disable market notifications' },
    { command: 'status', description: '🌡️ View current temperatures' },
    { command: 'timezone', description: '🕐 Peak hours in Lisbon time' },
    { command: 'track', description: '🔍 Track a market (updates every 10s)' },
    { command: 'untrackall', description: '🛑 Stop all tracking' },
    { command: 'stop', description: '🛑 Unsubscribe from alerts' }
  ]).then(() => {
    console.log('📋 Bot command menu set up');
  }).catch(err => {
    console.error('Failed to set bot commands:', err.message);
  });
  
  console.log('🤖 Telegram bot initialized and listening...');
  return bot;
}

/**
 * Start tracking a location for a user
 */
function startTracking(chatId, locationId, location) {
  const intervalKey = `${chatId}_${locationId}`;
  
  // Clear any existing interval
  if (trackingIntervals.has(intervalKey)) {
    clearInterval(trackingIntervals.get(intervalKey));
  }
  
  // Create tracking interval (every 10 seconds)
  const interval = setInterval(async () => {
    try {
      // Check if tracking is still active
      if (!activeTrackings.has(chatId)) {
        clearInterval(interval);
        trackingIntervals.delete(intervalKey);
        return;
      }
      
      const userTrackings = activeTrackings.get(chatId);
      if (!userTrackings || !userTrackings.has(locationId)) {
        clearInterval(interval);
        trackingIntervals.delete(intervalKey);
        return;
      }
      
      const tracking = userTrackings.get(locationId);
      
      // Fetch current data
      const result = await fetchWeatherData(location);
      
      if (!result.success) {
        // Update message with error
        const errorTime = new Date().toLocaleTimeString();
        try {
          await bot.editMessageText(
            `🔍 *Tracking ${location.emoji} ${location.name}*\n\n` +
            `❌ Error fetching data\n` +
            `_Last check: ${errorTime}_`,
            {
              chat_id: chatId,
              message_id: tracking.messageId,
              parse_mode: 'Markdown'
            }
          );
        } catch (err) {
          // Message might be deleted, stop tracking
          stopTracking(chatId, locationId);
        }
        return;
      }
      
      const currentTemp = extractCurrentTemp(result.data);
      const localTime = getLocalTime(location.timezone);
      const checkTime = new Date().toLocaleTimeString();
      
      if (currentTemp === null) {
        // Update message with no data
        try {
          await bot.editMessageText(
            `🔍 *Tracking ${location.emoji} ${location.name}*\n\n` +
            `⚠️ Could not extract temperature\n` +
            `_Last check: ${checkTime}_`,
            {
              chat_id: chatId,
              message_id: tracking.messageId,
              parse_mode: 'Markdown'
            }
          );
        } catch (err) {
          stopTracking(chatId, locationId);
        }
        return;
      }
      
      // Check if temperature changed
      const tempChanged = tracking.lastTemp !== null && tracking.lastTemp !== currentTemp;
      
      // Update the tracking message with latest check
      try {
        await bot.editMessageText(
          `🔍 *Tracking ${location.emoji} ${location.name}*\n\n` +
          `🌡️ Temperature: *${currentTemp}°C*\n` +
          `🕐 Local time: ${localTime}\n` +
          `_Last check: ${checkTime}_`,
          {
            chat_id: chatId,
            message_id: tracking.messageId,
            parse_mode: 'Markdown'
          }
        );
      } catch (err) {
        // Message might be deleted, stop tracking
        stopTracking(chatId, locationId);
        return;
      }
      
      // If temperature changed, send a NEW message
      if (tempChanged) {
        const change = currentTemp > tracking.lastTemp ? '↑' : '↓';
        const changeAmount = Math.abs(currentTemp - tracking.lastTemp);
        
        await bot.sendMessage(chatId,
          `📊 *NEW DATA POINT*\n\n` +
          `${location.emoji} *${location.name}*\n\n` +
          `🌡️ Temperature: *${currentTemp}°C* ${change}${changeAmount}°C\n` +
          `📊 Previous: ${tracking.lastTemp}°C\n` +
          `🕐 ${localTime}\n` +
          `🕐 Checked: ${checkTime}`,
          { parse_mode: 'Markdown' }
        );
        
        console.log(`📊 ${location.name} temp changed: ${tracking.lastTemp}°C → ${currentTemp}°C`);
      }
      
      // Update tracking state
      tracking.lastTemp = currentTemp;
      tracking.lastUpdateTime = new Date();
      
    } catch (err) {
      console.error(`Error in tracking loop for ${location.name}:`, err.message);
    }
  }, 10000); // 10 seconds
  
  trackingIntervals.set(intervalKey, interval);
}

/**
 * Stop tracking a location for a user
 */
function stopTracking(chatId, locationId) {
  const intervalKey = `${chatId}_${locationId}`;
  
  if (trackingIntervals.has(intervalKey)) {
    clearInterval(trackingIntervals.get(intervalKey));
    trackingIntervals.delete(intervalKey);
  }
  
  if (activeTrackings.has(chatId)) {
    const userTrackings = activeTrackings.get(chatId);
    userTrackings.delete(locationId);
    
    if (userTrackings.size === 0) {
      activeTrackings.delete(chatId);
    }
  }
  
  console.log(`🛑 Stopped tracking ${locationId} for user ${chatId}`);
}

/**
 * Set the status handler (called from weather module)
 */
export function setStatusHandler(handler) {
  if (bot) {
    bot.statusHandler = handler;
  }
}

/**
 * Send a message to all registered users who have a specific market enabled
 * @param {string} message - The message to send
 * @param {string} marketId - The market ID to filter users by (optional - if not provided, sends to all)
 * @param {object} options - Additional Telegram options
 */
export async function broadcastMessage(message, marketId = null, options = {}) {
  // Get users who have this market enabled (or all users if no marketId)
  const users = marketId ? getUsersForMarket(marketId) : loadUsers();
  
  if (users.length === 0) {
    console.log(`📭 No users to broadcast to${marketId ? ` for ${marketId}` : ''}`);
    return;
  }
  
  const defaultOptions = { parse_mode: 'Markdown' };
  const mergedOptions = { ...defaultOptions, ...options };
  
  let sentCount = 0;
  for (const user of users) {
    try {
      await bot.sendMessage(user.chatId, message, mergedOptions);
      sentCount++;
    } catch (err) {
      // Handle blocked/deleted users
      if (err.response?.statusCode === 403) {
        console.log(`🚫 User ${user.chatId} blocked the bot, removing...`);
        removeUser(user.chatId);
      } else {
        console.error(`Error sending to ${user.chatId}:`, err.message);
      }
    }
  }
  
  return sentCount;
}

/**
 * Send a message to a specific user
 */
export async function sendMessage(chatId, message, options = {}) {
  const defaultOptions = { parse_mode: 'Markdown' };
  const mergedOptions = { ...defaultOptions, ...options };
  
  try {
    await bot.sendMessage(chatId, message, mergedOptions);
  } catch (err) {
    console.error(`Error sending message to ${chatId}:`, err.message);
  }
}

/**
 * Get the bot instance
 */
export function getBot() {
  return bot;
}


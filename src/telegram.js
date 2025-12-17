/**
 * Telegram Bot Module
 * Handles bot initialization, user registration, and message broadcasting
 */

import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config/telegram.js';
import { addUser, removeUser, loadUsers, getUser, toggleUserMarket, getUsersForMarket } from './state.js';
import { locations } from '../config/locations.js';
import { getAllAttentionZonesWithLisbon } from './weather.js';

let bot = null;

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
  
  // Set up the bot command menu (blue button)
  bot.setMyCommands([
    { command: 'start', description: '🚀 Subscribe to weather alerts' },
    { command: 'markets', description: '🌍 Enable/disable market notifications' },
    { command: 'status', description: '🌡️ View current temperatures' },
    { command: 'timezone', description: '🕐 Peak hours in Lisbon time' },
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


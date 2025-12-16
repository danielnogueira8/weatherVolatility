/**
 * Weather Polling Service
 * Fetches weather data and processes temperature changes
 */

import axios from 'axios';
import moment from 'moment-timezone';
import { locations, API_BASE_URL } from '../config/locations.js';
import { loadLocationState, saveLocationState, cleanupOldStateFiles } from './state.js';
import { broadcastMessage, sendMessage, setStatusHandler } from './telegram.js';

// Store for current readings (for /status command)
const currentReadings = new Map();

/**
 * Get the current date string for a location in its timezone
 */
function getLocalDate(timezone) {
  return moment().tz(timezone).format('YYYY-MM-DD');
}

/**
 * Get the current time string for a location in its timezone
 */
function getLocalTime(timezone) {
  return moment().tz(timezone).format('h:mm A');
}

/**
 * Fetch weather data for a location
 * Handles timezone edge cases where local date might be "future" for the API
 */
async function fetchWeatherData(location) {
  const localDate = getLocalDate(location.timezone);
  const url = `${API_BASE_URL}?location=${location.apiPath}&date=${localDate}`;
  
  console.log(`\n📡 [${location.name}] Fetching: ${url}`);
  
  try {
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;
    
    // Log the response details
    const current = data?.data?.current?.temperature?.celsius;
    const dailyMax = data?.data?.daily?.temperature?.max;
    const dailyMin = data?.data?.daily?.temperature?.min;
    const condition = data?.data?.current?.condition;
    const cacheHit = data?.metadata?.cache_hit;
    
    console.log(`   ✅ Response: current=${current}°C, dailyMax=${dailyMax}°C, dailyMin=${dailyMin}°C`);
    console.log(`   📋 Condition: "${condition}" | Cache: ${cacheHit ? 'HIT' : 'MISS'}`);
    
    return {
      success: true,
      data: response.data,
      localDate
    };
  } catch (err) {
    // If the API says date is in the future, try yesterday's date
    if (err.response?.status === 400) {
      const responseData = err.response?.data;
      const isFutureDateError = responseData?.error?.details?.some(
        d => d.message?.includes('future')
      );
      
      if (isFutureDateError) {
        // Try with yesterday's date (API might not have today's data yet)
        const yesterdayDate = moment().tz(location.timezone).subtract(1, 'day').format('YYYY-MM-DD');
        const fallbackUrl = `${API_BASE_URL}?location=${location.apiPath}&date=${yesterdayDate}`;
        
        console.log(`   ⏰ Local date ${localDate} is future for API, retrying with ${yesterdayDate}`);
        console.log(`   📡 Fallback URL: ${fallbackUrl}`);
        
        try {
          const fallbackResponse = await axios.get(fallbackUrl, { timeout: 10000 });
          const data = fallbackResponse.data;
          
          // Log fallback response
          const current = data?.data?.current?.temperature?.celsius;
          const dailyMax = data?.data?.daily?.temperature?.max;
          const condition = data?.data?.current?.condition;
          
          console.log(`   ✅ Fallback response: current=${current}°C, dailyMax=${dailyMax}°C`);
          console.log(`   📋 Condition: "${condition}"`);
          
          return {
            success: true,
            data: fallbackResponse.data,
            localDate: yesterdayDate,
            isFallback: true
          };
        } catch (fallbackErr) {
          console.error(`   ❌ Fallback failed: ${fallbackErr.message}`);
        }
      }
    }
    
    console.error(`   ❌ Error: ${err.message}`);
    if (err.response?.data) {
      console.error(`   📄 Response: ${JSON.stringify(err.response.data)}`);
    }
    
    return {
      success: false,
      error: err.message,
      localDate
    };
  }
}

/**
 * Extract current temperature from API response
 * API structure: { success: true, data: { current: { temperature: { celsius: X } } } }
 */
function extractCurrentTemp(apiResponse) {
  // The API wraps everything in { success, data }
  const data = apiResponse?.data || apiResponse;
  
  // Primary path: data.current.temperature.celsius
  if (typeof data?.current?.temperature?.celsius === 'number') {
    return data.current.temperature.celsius;
  }
  
  // Fallback: check for hourly_data and get the latest
  if (data?.hourly_data && Array.isArray(data.hourly_data) && data.hourly_data.length > 0) {
    const latest = data.hourly_data[data.hourly_data.length - 1];
    if (typeof latest?.temperature_c === 'number') {
      return latest.temperature_c;
    }
  }
  
  // Other fallbacks
  if (typeof data?.temperature?.celsius === 'number') return data.temperature.celsius;
  if (typeof data?.temp === 'number') return data.temp;
  
  return null;
}

/**
 * Extract daily high temperature from API response
 * API structure: { success: true, data: { daily: { temperature: { max: X } } } }
 */
function extractDailyHigh(apiResponse) {
  const data = apiResponse?.data || apiResponse;
  
  // Primary path: data.daily.temperature.max
  if (typeof data?.daily?.temperature?.max === 'number') {
    return data.daily.temperature.max;
  }
  
  // Fallback: find max from hourly_data
  if (data?.hourly_data && Array.isArray(data.hourly_data) && data.hourly_data.length > 0) {
    const temps = data.hourly_data
      .map(h => h.temperature_c)
      .filter(t => typeof t === 'number');
    if (temps.length > 0) {
      return Math.max(...temps);
    }
  }
  
  return null;
}

/**
 * Process temperature data for a location and generate alerts
 */
async function processLocation(location) {
  const result = await fetchWeatherData(location);
  
  if (!result.success) {
    return null;
  }
  
  const currentTemp = extractCurrentTemp(result.data);
  const dailyHigh = extractDailyHigh(result.data);
  
  if (currentTemp === null) {
    console.log(`⚠️ Could not extract temperature for ${location.name}`);
    return null;
  }
  
  // Use the API date for state management, but actual local date for display
  const apiDate = result.localDate;
  const actualLocalDate = getLocalDate(location.timezone);
  const localTime = getLocalTime(location.timezone);
  const state = loadLocationState(location.id, apiDate);
  
  // Determine the high to display:
  // - If we have a tracked high, use the MAX of (our tracked high, current temp)
  // - If no tracked high yet (first reading), use current temp
  const displayHigh = state.highTemp !== null 
    ? Math.max(state.highTemp, currentTemp) 
    : currentTemp;
  
  // Store for /status command
  currentReadings.set(location.id, {
    temp: currentTemp,
    time: localTime,
    date: actualLocalDate,  // Show actual local date, not API fallback date
    high: displayHigh,      // Use our tracked/observed high
    apiDailyMax: dailyHigh, // Keep API's daily max for reference
    isFallback: result.isFallback || false
  });
  
  const alerts = [];
  
  // First reading of the day - establish baseline silently
  if (state.highTemp === null) {
    state.highTemp = currentTemp;
    state.lastTemp = currentTemp;
    state.hasAlertedDrop = false;
    state.history.push({ temp: currentTemp, time: localTime });
    saveLocationState(location.id, apiDate, state);
    
    console.log(`   📊 BASELINE SET: ${currentTemp}°C`);
    return null;
  }
  
  // Log current state
  console.log(`   📊 State: trackedHigh=${state.highTemp}°C, lastTemp=${state.lastTemp}°C, hasAlertedDrop=${state.hasAlertedDrop}`);
  console.log(`   🌡️  Current: ${currentTemp}°C | Display High: ${displayHigh}°C`);
  
  // Check for new high (based on our tracked observations)
  if (currentTemp > state.highTemp) {
    const prevHigh = state.highTemp;
    state.highTemp = currentTemp;
    state.hasAlertedDrop = false; // Reset drop alert flag for new high
    
    alerts.push({
      type: 'new_high',
      location,
      temp: currentTemp,
      prevHigh,
      time: localTime,
      date: actualLocalDate
    });
    
    console.log(`   🚨 ALERT: NEW HIGH ${currentTemp}°C (prev: ${prevHigh}°C)`);
  }
  // Check for first drop from high
  else if (currentTemp < state.highTemp && !state.hasAlertedDrop) {
    state.hasAlertedDrop = true;
    
    alerts.push({
      type: 'drop',
      location,
      temp: currentTemp,
      high: state.highTemp,
      time: localTime,
      date: actualLocalDate
    });
    
    console.log(`   🚨 ALERT: DROPPED to ${currentTemp}°C (high was: ${state.highTemp}°C)`);
  } else {
    console.log(`   ✓ No alert needed`);
  }
  
  // Update state
  state.lastTemp = currentTemp;
  state.history.push({ temp: currentTemp, time: localTime });
  saveLocationState(location.id, apiDate, state);
  
  return alerts.length > 0 ? alerts : null;
}

/**
 * Check if local time is in the critical window (1PM - 3:30PM)
 */
function isInCriticalWindow(timezone) {
  const now = moment().tz(timezone);
  const hour = now.hour();
  const minute = now.minute();
  
  // 1:00 PM (13:00) to 3:30 PM (15:30)
  const timeInMinutes = hour * 60 + minute;
  const startWindow = 13 * 60;      // 1:00 PM = 780 minutes
  const endWindow = 15 * 60 + 30;   // 3:30 PM = 930 minutes
  
  return timeInMinutes >= startWindow && timeInMinutes <= endWindow;
}

/**
 * Format alert message for Telegram
 */
function formatAlert(alert) {
  const { location, temp, time, date } = alert;
  const dateFormatted = moment(date).format('MMM D');
  
  // Check if this alert is during the critical window
  const isCritical = isInCriticalWindow(location.timezone);
  const criticalHeader = isCritical 
    ? `🚨🚨🚨 *PEAK HOURS ALERT* 🚨🚨🚨\n\n` 
    : '';
  const criticalFooter = isCritical 
    ? `\n\n⚠️ *CRITICAL WINDOW: 1PM-3:30PM*` 
    : '';
  
  if (alert.type === 'new_high') {
    const title = isCritical ? '🔴 *NEW HIGH RECORDED*' : '📈 *NEW HIGH RECORDED*';
    return (
      `${criticalHeader}${title}\n\n` +
      `${location.emoji} *${location.name}*\n` +
      `🌡️ Temperature: *${temp}°C*\n` +
      `📊 Previous High: ${alert.prevHigh}°C\n` +
      `🕐 Time: ${time} (${dateFormatted})${criticalFooter}`
    );
  }
  
  if (alert.type === 'drop') {
    const dropAmount = (alert.high - temp).toFixed(1);
    const title = isCritical ? '🔴 *TEMPERATURE DROP*' : '📉 *TEMPERATURE DROP*';
    return (
      `${criticalHeader}${title}\n\n` +
      `${location.emoji} *${location.name}*\n` +
      `🌡️ Current: *${temp}°C*\n` +
      `📊 Day's High: ${alert.high}°C (↓${dropAmount}°C)\n` +
      `🕐 Time: ${time} (${dateFormatted})${criticalFooter}`
    );
  }
  
  return '';
}

/**
 * Main polling function - processes all locations
 */
export async function pollAllLocations() {
  console.log(`\n⏰ Polling all locations at ${new Date().toISOString()}`);
  
  const allAlerts = [];
  
  for (const location of locations) {
    try {
      const alerts = await processLocation(location);
      if (alerts) {
        allAlerts.push(...alerts);
      }
    } catch (err) {
      console.error(`Error processing ${location.name}:`, err.message);
    }
    
    // Small delay between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Send alerts to users who have each market enabled
  for (const alert of allAlerts) {
    const message = formatAlert(alert);
    if (message) {
      const sentCount = await broadcastMessage(message, alert.location.id);
      console.log(`   📤 Sent ${alert.location.name} alert to ${sentCount} user(s)`);
    }
  }
  
  console.log(`✅ Polling complete. ${allAlerts.length} alert(s) processed.`);
}

/**
 * Handle /status command
 */
async function handleStatus(chatId) {
  if (currentReadings.size === 0) {
    await sendMessage(chatId, '⏳ No data yet. Waiting for first poll...');
    return;
  }
  
  let message = '🌡️ *Current Temperatures*\n\n';
  
  for (const location of locations) {
    const reading = currentReadings.get(location.id);
    
    if (reading) {
      const highInfo = reading.high !== null ? ` (High: ${reading.high}°C)` : '';
      const fallbackNote = reading.isFallback ? ' ⏳' : '';
      message += `${location.emoji} *${location.name}*: ${reading.temp}°C${highInfo}${fallbackNote}\n`;
      message += `   └ ${reading.time} • ${reading.date}\n\n`;
    } else {
      message += `${location.emoji} *${location.name}*: No data\n\n`;
    }
  }
  
  message += `_Last updated: ${new Date().toLocaleTimeString()}_\n`;
  message += `_⏳ = Data from previous day (new day data pending)_`;
  
  await sendMessage(chatId, message);
}

/**
 * Calculate milliseconds until next poll time
 * Polls at :00:10, :05:10, :10:10, etc. (every 5 minutes with 10 second offset)
 */
function getMillisUntilNextPoll() {
  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const ms = now.getMilliseconds();
  
  // Find next 5-minute interval
  const nextInterval = Math.ceil(minutes / 5) * 5;
  const minutesToWait = nextInterval - minutes;
  
  // Calculate target time (next interval + 10 seconds)
  let targetMs = (minutesToWait * 60 * 1000) - (seconds * 1000) - ms + (10 * 1000);
  
  // If we're past the 10-second mark of current interval, wait for next
  if (targetMs <= 0) {
    targetMs += 5 * 60 * 1000; // Add 5 minutes
  }
  
  return targetMs;
}

/**
 * Schedule next poll
 */
function scheduleNextPoll() {
  const msUntilNext = getMillisUntilNextPoll();
  const nextTime = new Date(Date.now() + msUntilNext);
  
  console.log(`⏳ Next poll scheduled for ${nextTime.toLocaleTimeString()} (in ${Math.round(msUntilNext / 1000)}s)`);
  
  setTimeout(async () => {
    await pollAllLocations();
    scheduleNextPoll();
  }, msUntilNext);
}

/**
 * Initialize the weather service
 */
export async function initWeatherService() {
  console.log('🌤️ Weather service initializing...');
  
  // Set up status handler for Telegram
  setStatusHandler(handleStatus);
  
  // Clean up old state files
  cleanupOldStateFiles();
  
  // Do initial poll immediately
  console.log('📡 Running initial poll...');
  await pollAllLocations();
  
  // Schedule regular polls
  scheduleNextPoll();
  
  console.log('✅ Weather service initialized');
}


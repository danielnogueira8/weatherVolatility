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

// Store for dynamic attention zones per location (calculated from historical data)
// Format: { locationId: { startHour: 13, startMin: 0, endHour: 16, endMin: 0 } }
const attentionZones = new Map();

// Store for average sustained high counts per location (from historical data)
// Format: { locationId: { avgSustainedCount: 5, data: [3, 5, 7, 4, 6, 5, 5] } }
const sustainedHighStats = new Map();

/**
 * Log to console only
 */
function debugLog(message) {
  console.log(message);
}

/**
 * Parse time string (e.g., "2:30 PM") to hours and minutes
 */
function parseTimeString(timeStr) {
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  
  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const period = match[3].toUpperCase();
  
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  
  return { hours, minutes };
}

/**
 * Fetch historical data for a location for a specific date
 */
async function fetchHistoricalData(location, date) {
  const url = `${API_BASE_URL}?location=${location.apiPath}&date=${date}`;
  
  try {
    const response = await axios.get(url, { timeout: 10000 });
    return response.data;
  } catch (err) {
    return null;
  }
}

/**
 * Find when the daily high occurred from hourly data
 * Returns the hour (0-23) when the max temperature was recorded
 */
function findHighTempTime(hourlyData) {
  if (!hourlyData || hourlyData.length === 0) return null;
  
  let maxTemp = -Infinity;
  let maxTimeHour = null;
  
  for (const entry of hourlyData) {
    if (entry.temperature_c > maxTemp) {
      maxTemp = entry.temperature_c;
      const parsed = parseTimeString(entry.time);
      if (parsed) {
        maxTimeHour = parsed.hours;
      }
    }
  }
  
  return maxTimeHour;
}

/**
 * Count how many consecutive readings stayed at the daily high before dropping
 * Returns the count of sustained high readings
 */
function countSustainedHighReadings(hourlyData) {
  if (!hourlyData || hourlyData.length === 0) return 0;
  
  // Find the max temperature
  const maxTemp = Math.max(...hourlyData.map(h => h.temperature_c));
  
  // Find the first occurrence of max temp
  let firstMaxIndex = hourlyData.findIndex(h => h.temperature_c === maxTemp);
  if (firstMaxIndex === -1) return 0;
  
  // Count consecutive readings at max temp
  let sustainedCount = 0;
  for (let i = firstMaxIndex; i < hourlyData.length; i++) {
    if (hourlyData[i].temperature_c === maxTemp) {
      sustainedCount++;
    } else if (hourlyData[i].temperature_c < maxTemp) {
      // Temperature dropped, stop counting
      break;
    }
  }
  
  return sustainedCount;
}

/**
 * Calculate the attention zone for a location based on last 7 days
 * Also calculates average sustained high count
 * Returns a 3-hour window centered around the most common high time
 */
async function calculateAttentionZone(location) {
  debugLog(`\n📊 Calculating attention zone for ${location.name}...`);
  
  const highTimes = [];
  const sustainedCounts = [];
  const today = moment().tz(location.timezone);
  
  // Fetch last 7 days of data
  for (let i = 1; i <= 7; i++) {
    const date = today.clone().subtract(i, 'days').format('YYYY-MM-DD');
    const data = await fetchHistoricalData(location, date);
    
    if (data?.data?.hourly_data) {
      const highHour = findHighTempTime(data.data.hourly_data);
      const sustainedCount = countSustainedHighReadings(data.data.hourly_data);
      
      if (highHour !== null) {
        highTimes.push(highHour);
        sustainedCounts.push(sustainedCount);
        debugLog(`   ${date}: High at ${highHour}:00, sustained for ${sustainedCount} readings`);
      }
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  if (highTimes.length === 0) {
    debugLog(`   ⚠️ No historical data, using default 1PM-4PM`);
    sustainedHighStats.set(location.id, { avgSustainedCount: 4, data: [] });
    return { startHour: 13, startMin: 0, endHour: 16, endMin: 0 };
  }
  
  // Calculate the average hour when highs occur
  const avgHour = Math.round(highTimes.reduce((a, b) => a + b, 0) / highTimes.length);
  
  // Calculate the average sustained high count
  const avgSustained = sustainedCounts.length > 0 
    ? Math.round(sustainedCounts.reduce((a, b) => a + b, 0) / sustainedCounts.length)
    : 4;
  
  // Store sustained high stats
  sustainedHighStats.set(location.id, { 
    avgSustainedCount: avgSustained, 
    data: sustainedCounts 
  });
  
  // Create a 3-hour window centered around the average
  // But shift slightly earlier since highs tend to occur mid-window
  const startHour = Math.max(0, avgHour - 1);
  const endHour = Math.min(23, avgHour + 2);
  
  debugLog(`   ✅ Attention zone: ${startHour}:00 - ${endHour}:00 (avg high at ${avgHour}:00)`);
  debugLog(`   📈 Avg sustained readings at high: ${avgSustained}`);
  
  return { startHour, startMin: 0, endHour, endMin: 0 };
}

/**
 * Initialize attention zones for all locations
 */
async function initAttentionZones() {
  debugLog('\n🎯 Initializing dynamic attention zones...');
  
  for (const location of locations) {
    const zone = await calculateAttentionZone(location);
    attentionZones.set(location.id, zone);
  }
  
  debugLog('\n✅ Attention zones initialized\n');
}

/**
 * Get attention zone info for a location (for display)
 */
export function getAttentionZoneInfo(locationId) {
  const zone = attentionZones.get(locationId);
  if (!zone) return null;
  
  const formatHour = (h) => {
    const period = h >= 12 ? 'PM' : 'AM';
    const hour12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
    return `${hour12}${period}`;
  };
  
  return `${formatHour(zone.startHour)} - ${formatHour(zone.endHour)}`;
}

/**
 * Get all attention zones (for /timezone command)
 */
export function getAllAttentionZones() {
  const zones = {};
  for (const [locationId, zone] of attentionZones) {
    zones[locationId] = {
      ...zone,
      display: getAttentionZoneInfo(locationId)
    };
  }
  return zones;
}

/**
 * Get sustained high stats for a location
 */
function getSustainedHighStats(locationId) {
  return sustainedHighStats.get(locationId) || { avgSustainedCount: 4, data: [] };
}

/**
 * Convert attention zone times to Lisbon timezone
 * Returns formatted string like "1PM - 4PM"
 */
function convertZoneToLisbonTime(location, zone) {
  if (!zone) return null;
  
  const formatHour = (h) => {
    const period = h >= 12 ? 'PM' : 'AM';
    const hour12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
    return `${hour12}${period}`;
  };
  
  // Create moment objects in the location's timezone
  const today = moment().tz(location.timezone);
  const startTime = today.clone().hour(zone.startHour).minute(zone.startMin).second(0);
  const endTime = today.clone().hour(zone.endHour).minute(zone.endMin).second(0);
  
  // Convert to Lisbon time (Europe/Lisbon)
  const startLisbon = startTime.clone().tz('Europe/Lisbon');
  const endLisbon = endTime.clone().tz('Europe/Lisbon');
  
  return `${formatHour(startLisbon.hour())} - ${formatHour(endLisbon.hour())}`;
}

/**
 * Get all attention zones with Lisbon time conversion
 */
export function getAllAttentionZonesWithLisbon() {
  const zones = {};
  for (const location of locations) {
    const zone = attentionZones.get(location.id);
    const localDisplay = getAttentionZoneInfo(location.id) || 'Calculating...';
    const lisbonDisplay = zone ? convertZoneToLisbonTime(location, zone) : 'Calculating...';
    
    zones[location.id] = {
      ...zone,
      display: localDisplay,
      lisbonDisplay: lisbonDisplay,
      location: location
    };
  }
  return zones;
}

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
  
  debugLog(`\n📡 [${location.name}] ${url}`);
  
  try {
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;
    
    // Log the response details
    const current = data?.data?.current?.temperature?.celsius;
    const dailyMax = data?.data?.daily?.temperature?.max;
    const dailyMin = data?.data?.daily?.temperature?.min;
    const condition = data?.data?.current?.condition;
    const cacheHit = data?.metadata?.cache_hit;
    
    debugLog(`   ✅ cur=${current}°C max=${dailyMax}°C min=${dailyMin}°C`);
    debugLog(`   📋 "${condition}" | Cache: ${cacheHit ? 'HIT' : 'MISS'}`);
    
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
        
        debugLog(`   ⏰ Future date, using ${yesterdayDate}`);
        
        try {
          const fallbackResponse = await axios.get(fallbackUrl, { timeout: 10000 });
          const data = fallbackResponse.data;
          
          // Log fallback response
          const current = data?.data?.current?.temperature?.celsius;
          const dailyMax = data?.data?.daily?.temperature?.max;
          const condition = data?.data?.current?.condition;
          
          debugLog(`   ✅ cur=${current}°C max=${dailyMax}°C`);
          debugLog(`   📋 "${condition}"`);
          
          return {
            success: true,
            data: fallbackResponse.data,
            localDate: yesterdayDate,
            isFallback: true
          };
        } catch (fallbackErr) {
          debugLog(`   ❌ Fallback failed: ${fallbackErr.message}`);
        }
      }
    }
    
    debugLog(`   ❌ Error: ${err.message}`);
    if (err.response?.data) {
      debugLog(`   📄 ${JSON.stringify(err.response.data)}`);
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
 * PRIORITY: Use most recent hourly_data entry (more up-to-date than 'current' which may be cached)
 */
function extractCurrentTemp(apiResponse) {
  // The API wraps everything in { success, data }
  const data = apiResponse?.data || apiResponse;
  
  // PRIMARY: Use the most recent hourly_data entry (more reliable/recent than 'current')
  if (data?.hourly_data && Array.isArray(data.hourly_data) && data.hourly_data.length > 0) {
    const latest = data.hourly_data[data.hourly_data.length - 1];
    if (typeof latest?.temperature_c === 'number') {
      return latest.temperature_c;
    }
  }
  
  // Fallback: data.current.temperature.celsius (may be cached/stale)
  if (typeof data?.current?.temperature?.celsius === 'number') {
    return data.current.temperature.celsius;
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
    debugLog(`⚠️ Could not extract temp for ${location.name}`);
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
    
    debugLog(`   📊 BASELINE: ${currentTemp}°C`);
    return null;
  }
  
  // Log current state
  debugLog(`   📊 high=${state.highTemp}°C last=${state.lastTemp}°C drop=${state.hasAlertedDrop}`);
  debugLog(`   🌡️ cur=${currentTemp}°C disp=${displayHigh}°C`);
  
  // Check if we're in the attention zone
  const inAttentionZone = isInCriticalWindow(location.timezone, location.id);
  
  // Check for new high (based on our tracked observations)
  if (currentTemp > state.highTemp) {
    const prevHigh = state.highTemp;
    state.highTemp = currentTemp;
    state.hasAlertedDrop = false; // Reset drop alert flag for new high
    state.sustainedHighCount = 1; // Reset sustained count for new high
    state.lastHighAlertTemp = currentTemp; // Track what temp we alerted for
    
    alerts.push({
      type: 'new_high',
      location,
      temp: currentTemp,
      prevHigh,
      time: localTime,
      date: actualLocalDate
    });
    
    debugLog(`   🚨 NEW HIGH ${currentTemp}°C (was ${prevHigh}°C)`);
  }
  // Check for first drop from high
  else if (currentTemp < state.highTemp && !state.hasAlertedDrop) {
    state.hasAlertedDrop = true;
    state.sustainedHighCount = 0; // Reset sustained count on drop
    
    alerts.push({
      type: 'drop',
      location,
      temp: currentTemp,
      high: state.highTemp,
      time: localTime,
      date: actualLocalDate
    });
    
    debugLog(`   🚨 DROP to ${currentTemp}°C (high ${state.highTemp}°C)`);
  }
  // Check for sustained high during attention zone (temp equals current high)
  else if (inAttentionZone && currentTemp === state.highTemp && !state.hasAlertedDrop) {
    // Initialize if not set
    if (!state.sustainedHighCount) state.sustainedHighCount = 1;
    
    // Increment sustained count
    state.sustainedHighCount++;
    
    // Alert for sustained highs (2nd occurrence and beyond)
    if (state.sustainedHighCount >= 2) {
      alerts.push({
        type: 'sustained_high',
        location,
        temp: currentTemp,
        count: state.sustainedHighCount,
        time: localTime,
        date: actualLocalDate
      });
      
      debugLog(`   🔥 SUSTAINED HIGH x${state.sustainedHighCount} at ${currentTemp}°C`);
    }
  } else {
    debugLog(`   ✓ No alert`);
  }
  
  // Update state
  state.lastTemp = currentTemp;
  state.history.push({ temp: currentTemp, time: localTime });
  saveLocationState(location.id, apiDate, state);
  
  return alerts.length > 0 ? alerts : null;
}

/**
 * Check if local time is in the attention zone for a location
 * Uses dynamic zones calculated from historical data
 */
function isInCriticalWindow(timezone, locationId) {
  const zone = attentionZones.get(locationId);
  
  // Fallback to default if no zone calculated
  if (!zone) {
    const now = moment().tz(timezone);
    const hour = now.hour();
    return hour >= 13 && hour < 16; // Default 1PM-4PM
  }
  
  const now = moment().tz(timezone);
  const hour = now.hour();
  const minute = now.minute();
  
  const timeInMinutes = hour * 60 + minute;
  const startWindow = zone.startHour * 60 + zone.startMin;
  const endWindow = zone.endHour * 60 + zone.endMin;
  
  return timeInMinutes >= startWindow && timeInMinutes <= endWindow;
}

/**
 * Format alert message for Telegram
 */
function formatAlert(alert) {
  const { location, temp, time, date } = alert;
  const dateFormatted = moment(date).format('MMM D');
  
  // Check if this alert is during the attention zone (dynamic per location)
  const isCritical = isInCriticalWindow(location.timezone, location.id);
  const zoneInfo = getAttentionZoneInfo(location.id) || '1PM - 4PM';
  
  if (alert.type === 'new_high') {
    if (isCritical) {
      // SPECIAL ALERT: New high during attention zone
      return (
        `🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n` +
        `⚠️ *ATTENTION ZONE - NEW HIGH* ⚠️\n` +
        `🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n` +
        `${location.emoji} *${location.name}*\n\n` +
        `🌡️ NEW HIGH: *${temp}°C*\n` +
        `📊 Previous: ${alert.prevHigh}°C (+${temp - alert.prevHigh}°C)\n` +
        `🕐 ${time} (${dateFormatted})\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⏰ *PEAK WINDOW: ${zoneInfo}*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━`
      );
    } else {
      return (
        `📈 *NEW HIGH RECORDED*\n\n` +
        `${location.emoji} *${location.name}*\n` +
        `🌡️ Temperature: *${temp}°C*\n` +
        `📊 Previous High: ${alert.prevHigh}°C\n` +
        `🕐 Time: ${time} (${dateFormatted})`
      );
    }
  }
  
  if (alert.type === 'drop') {
    const dropAmount = (alert.high - temp).toFixed(1);
    
    if (isCritical) {
      // SPECIAL ALERT: First drop during attention zone
      return (
        `🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n` +
        `⚠️ *ATTENTION ZONE - DROP* ⚠️\n` +
        `🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n` +
        `${location.emoji} *${location.name}*\n\n` +
        `🌡️ DROPPED TO: *${temp}°C*\n` +
        `📊 From High: ${alert.high}°C (↓${dropAmount}°C)\n` +
        `🕐 ${time} (${dateFormatted})\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⏰ *PEAK WINDOW: ${zoneInfo}*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━`
      );
    } else {
      return (
        `📉 *TEMPERATURE DROP*\n\n` +
        `${location.emoji} *${location.name}*\n` +
        `🌡️ Current: *${temp}°C*\n` +
        `📊 Day's High: ${alert.high}°C (↓${dropAmount}°C)\n` +
        `🕐 Time: ${time} (${dateFormatted})`
      );
    }
  }
  
  // Sustained high during attention zone
  if (alert.type === 'sustained_high') {
    const ordinal = alert.count === 2 ? '2nd' : alert.count === 3 ? '3rd' : `${alert.count}th`;
    const stats = getSustainedHighStats(location.id);
    const avgCount = stats.avgSustainedCount;
    
    // Determine if we're below, at, or above average
    let comparison = '';
    if (alert.count < avgCount) {
      comparison = `📉 Below avg (usually ${avgCount} readings)`;
    } else if (alert.count === avgCount) {
      comparison = `📊 At avg (usually ${avgCount} readings)`;
    } else {
      comparison = `📈 Above avg! (usually ${avgCount} readings)`;
    }
    
    return (
      `🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥\n` +
      `🎯 *HIGH HOLDING STRONG* 🎯\n` +
      `🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥\n\n` +
      `${location.emoji} *${location.name}*\n\n` +
      `🌡️ *${temp}°C* — ${ordinal} reading at peak\n` +
      `${comparison}\n` +
      `🕐 ${time} (${dateFormatted})\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⏰ *PEAK WINDOW: ${zoneInfo}*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━`
    );
  }
  
  return '';
}

/**
 * Main polling function - processes all locations
 */
export async function pollAllLocations() {
  debugLog(`\n⏰ POLL @ ${new Date().toISOString()}`);
  
  const allAlerts = [];
  
  for (const location of locations) {
    try {
      const alerts = await processLocation(location);
      if (alerts) {
        allAlerts.push(...alerts);
      }
    } catch (err) {
      debugLog(`❌ ${location.name}: ${err.message}`);
    }
    
    // Small delay between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Send alerts to users who have each market enabled
  for (const alert of allAlerts) {
    const message = formatAlert(alert);
    if (message) {
      const sentCount = await broadcastMessage(message, alert.location.id);
      debugLog(`📤 ${alert.location.name} alert → ${sentCount} user(s)`);
    }
  }
  
  debugLog(`✅ Done. ${allAlerts.length} alert(s).`);
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
  
  console.log(`⏳ Next poll @ ${nextTime.toLocaleTimeString()} (${Math.round(msUntilNext / 1000)}s)`);
  
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
  
  // Calculate dynamic attention zones from historical data
  await initAttentionZones();
  
  // Do initial poll immediately
  console.log('📡 Running initial poll...');
  await pollAllLocations();
  
  // Schedule regular polls
  scheduleNextPoll();
  
  console.log('✅ Weather service initialized');
}


/**
 * Weather Volatility Alerts - Main Entry Point
 * 
 * Monitors weather data across multiple locations and sends
 * Telegram alerts when temperature highs/drops are detected.
 */

import 'dotenv/config';
import { initBot } from './telegram.js';
import { initWeatherService } from './weather.js';

console.log(`
╔═══════════════════════════════════════════════════════╗
║         🌡️  WEATHER VOLATILITY ALERTS  🌡️             ║
╠═══════════════════════════════════════════════════════╣
║  Monitoring: Atlanta, Seattle, NYC, London,           ║
║              Seoul, Toronto, Dallas                   ║
║  Poll Interval: Every 10 minutes (:00:10, :10:10...)  ║
╚═══════════════════════════════════════════════════════╝
`);

async function main() {
  try {
    // Initialize Telegram bot
    initBot();
    
    // Initialize weather monitoring service
    await initWeatherService();
    
    console.log('\n🚀 System is running! Press Ctrl+C to stop.\n');
    
  } catch (err) {
    console.error('❌ Fatal error during startup:', err);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n👋 Received SIGTERM, shutting down...');
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
});

// Start the application
main();


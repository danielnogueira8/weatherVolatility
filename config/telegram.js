/**
 * Telegram Bot Configuration
 * Reads from environment variables (loaded via dotenv)
 */

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found in environment variables!');
  console.error('   Make sure you have a .env file with TELEGRAM_BOT_TOKEN=your_token');
  process.exit(1);
}


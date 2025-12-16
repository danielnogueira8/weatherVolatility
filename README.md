# Weather Volatility Alerts 🌡️

A Node.js service that monitors weather temperatures across multiple global locations and sends real-time alerts via Telegram when significant temperature changes occur.

## Features

- **Multi-location monitoring**: Tracks temperatures in Atlanta, Seattle, NYC, London, Seoul, Toronto, and Dallas
- **Timezone-aware**: Each location is monitored according to its local timezone
- **Smart alerting**:
  - 📈 Alerts when a new daily high temperature is recorded
  - 📉 Alerts when temperature first drops below the day's high
- **Telegram integration**: Subscribe via bot to receive instant alerts
- **Persistent state**: Tracks temperature highs per location/day via JSON files

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the service**:
   ```bash
   npm start
   ```

3. **Subscribe to alerts**: Find your bot on Telegram and send `/start`

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Subscribe to weather alerts |
| `/markets` | Enable/disable alerts for specific markets |
| `/status` | View current temperatures for all locations |
| `/stop` | Unsubscribe from alerts |

## How Alerts Work

The system tracks the highest temperature recorded each day for each location:

1. **First reading**: Establishes the baseline silently
2. **New high**: If temperature exceeds the day's high → Alert sent
3. **First drop**: If temperature drops below the high (first time only) → Alert sent
4. **Subsequent drops**: No alerts until a new high is set

### Example

- 2:00 PM: 15°C (baseline set, no alert)
- 3:00 PM: 17°C → **📈 NEW HIGH alert**
- 4:00 PM: 16°C → **📉 DROP alert** (first drop from 17°C)
- 5:00 PM: 14°C → No alert (already notified of drop)
- 6:00 PM: 18°C → **📈 NEW HIGH alert**
- 7:00 PM: 17°C → **📉 DROP alert** (first drop from 18°C)

## Polling Schedule

The service polls at precise 5-minute intervals with a 10-second offset:
- `:00:10`, `:05:10`, `:10:10`, `:15:10`, etc.

This ensures data is available while maintaining round-number timing.

## Project Structure

```
weatherVolatility/
├── config/
│   ├── locations.js    # Location configs with timezones
│   └── telegram.js     # Telegram bot token
├── src/
│   ├── index.js        # Main entry point
│   ├── state.js        # State persistence (JSON)
│   ├── telegram.js     # Telegram bot handlers
│   └── weather.js      # Weather polling & alerts
├── data/               # Runtime state files (auto-created)
└── package.json
```

## Configuration

### Adding/Modifying Locations

Edit `config/locations.js`:

```javascript
{
  id: 'city_id',
  name: 'Display Name',
  emoji: '🏙️',
  apiPath: 'country/state/city/AIRPORT_CODE',
  timezone: 'Continent/City'
}
```

## Data Storage

State is stored in the `data/` directory:
- `{location}_{date}.json` - Daily temperature state per location
- `users.json` - Registered Telegram users

Old state files (>2 days) are automatically cleaned up on startup.


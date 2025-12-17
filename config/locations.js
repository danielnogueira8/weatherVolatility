/**
 * Location configuration with timezone mappings
 * Each location has its API path and corresponding timezone
 */

export const locations = [
  {
    id: 'atlanta',
    name: 'Atlanta',
    emoji: '🍑',
    apiPath: 'us/atlanta/KATL',
    timezone: 'America/New_York'
  },
  {
    id: 'seattle',
    name: 'Seattle',
    emoji: '☕',
    apiPath: 'us/seattle/KSEA',
    timezone: 'America/Los_Angeles'
  },
  {
    id: 'nyc',
    name: 'New York (JFK)',
    emoji: '🗽',
    apiPath: 'us/new-york/KJFK',
    timezone: 'America/New_York'
  },
  {
    id: 'london',
    name: 'London',
    emoji: '🇬🇧',
    apiPath: 'gb/london/EGLC',
    timezone: 'Europe/London'
  },
  {
    id: 'seoul',
    name: 'Seoul',
    emoji: '🇰🇷',
    apiPath: 'kr/incheon/RKSI',
    timezone: 'Asia/Seoul'
  },
  {
    id: 'toronto',
    name: 'Toronto',
    emoji: '🍁',
    apiPath: 'ca/mississauga/CYYZ',
    timezone: 'America/Toronto'
  },
  {
    id: 'dallas',
    name: 'Dallas',
    emoji: '🤠',
    apiPath: 'us/dallas/KDAL',
    timezone: 'America/Chicago'
  }
];

export const API_BASE_URL = 'https://wundergroundapi-production.up.railway.app/api/weather/history';


const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cron = require('node-cron');
const { Expo } = require('expo-server-sdk');
const diningService = require('./simplifiedDiningScraper');
const showsService = require('./simplifiedShowsScraper'); // ADD THIS

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Expo push notification client
const expo = new Expo();

// Middleware
app.use(cors());
app.use(express.json());

// In-memory cache for wait times
let parkDataCache = {
  disneyland: { lands: {}, shows: {}, restaurants: {}, lastUpdated: null },
  californiaadventure: { lands: {}, shows: {}, restaurants: {}, lastUpdated: null }
};

// User preferences storage (in production, use a database)
let userPreferences = {};

// Device tokens for push notifications (in production, use a database)
let userDeviceTokens = {};

// Track which rides have been notified to avoid spam
let notifiedRides = {};

// User show schedules by date (in production, use a database)
let userShowSchedules = {}; // { userId: { 'YYYY-MM-DD': [{ showId, showName, selectedTime, travelTime, notified, finalWarningNotified }] } }

// User dining schedules by date (in production, use a database)
let userDiningSchedules = {}; // { userId: { 'YYYY-MM-DD': [{ id, restaurantName, time, type, travelTime, notified }] } }

// User Lightning Lane times (in production, use a database)
let userLightningLanes = {}; // { userId: { 'YYYY-MM-DD': { rideId: { rideName, returnTime, travelTime, notified } } } }

// Archived schedules (in production, use a database)
let archivedSchedules = {}; // { userId: { 'YYYY-MM-DD': { shows: [], dining: [], lightningLanes: {} } } }

// ThemeParks.wiki API base URL
const THEMEPARKS_API = 'https://api.themeparks.wiki/v1';

// Park IDs from ThemeParks.wiki
const PARK_IDS = {
  disneyland: '7340550b-c14d-4def-80bb-acdb51d49a66',
  californiaadventure: '832fcd51-ea19-4e77-85c7-75d5843b127c'
};

// Land mappings for Disneyland
const DISNEYLAND_LAND_MAP = {
  'mainstreet': 'Main Street U.S.A.',
  'adventureland': 'Adventureland',
  'frontierland': 'Frontierland',
  'fantasyland': 'Fantasyland',
  'tomorrowland': 'Tomorrowland',
  'neworleanssquare': 'New Orleans Square',
  'crittercountry': 'Critter Country',
  'mickeystoontown': "Mickey's Toontown",
  'starwars': 'Star Wars: Galaxy\'s Edge'
};

// Land mappings for California Adventure
const DCA_LAND_MAP = {
  'buenavista': 'Buena Vista Street',
  'hollywoodland': 'Hollywood Land',
  'avengers': 'Avengers Campus',
  'carsland': 'Cars Land',
  'grizzlypeak': 'Grizzly Peak',
  'pixarpier': 'Pixar Pier',
  'paradisegardens': 'Paradise Gardens'
};

/**
 * Fetch park data from ThemeParks.wiki API
 */
async function fetchParkData(parkId) {
  try {
    const liveDataResponse = await axios.get(
      `${THEMEPARKS_API}/entity/${parkId}/live`,
      { timeout: 10000 }
    );

    const childrenResponse = await axios.get(
      `${THEMEPARKS_API}/entity/${parkId}/children`,
      { timeout: 10000 }
    );

    return {
      liveData: liveDataResponse.data,
      children: childrenResponse.data
    };
  } catch (error) {
    console.error(`Error fetching park data for ${parkId}:`, error.message);
    throw error;
  }
}

/**
 * Process and organize park data into lands, shows, and restaurants
 */
function organizeParkData(parkData, landMap) {
  const lands = {};
  const shows = {};
  const restaurants = {};
  
  if (!parkData.children || !parkData.children.children) {
    return { lands, shows, restaurants };
  }

  parkData.children.children.forEach(entity => {
    // Determine land based on entity name or tags
    let landName = 'Other';
    if (entity.name) {
      const nameLower = entity.name.toLowerCase();
      for (const [key, value] of Object.entries(landMap)) {
        if (nameLower.includes(key)) {
          landName = value;
          break;
        }
      }
    }

    // Find live data for this entity
    const liveData = parkData.liveData.liveData?.find(
      live => live.id === entity.id
    );

    // Process ATTRACTIONS (rides)
    if (entity.entityType === 'ATTRACTION') {
      const ride = {
        id: entity.id,
        name: entity.name,
        currentWait: 0,
        avgWait: 30,
        status: 'CLOSED',
        returnTime: null,
        returnState: null,
        singleRiderWait: null,
        paidReturnState: null,
        paidReturnTime: null,
        paidReturnPrice: null,
        paidStandbyWait: null,
        forecastWait1: null,
        forecastWait2: null,
        forecastHour1: null,
        forecastHour2: null,
        hasLightningLane: false
      };
      
      // Map status from API first (before checking queue data)
      if (liveData) {
        if (liveData.status === 'OPERATING') {
          ride.status = 'OPERATING';
        } else if (liveData.status === 'DOWN') {
          ride.status = 'DOWN';
        } else if (liveData.status === 'REFURBISHMENT') {
          ride.status = 'REFURBISHMENT';
        } else if (liveData.status === 'CLOSED') {
          ride.status = 'CLOSED';
        } else {
          ride.status = liveData.status || 'CLOSED';
        }
      }
      
      // Add live wait time if available
      if (liveData && liveData.queue) {
        const standbyQueue = liveData.queue.STANDBY;
        if (standbyQueue) {
          ride.currentWait = standbyQueue.waitTime || 0;
        }
        
        // Check for RETURN_TIME queue (Lightning Lane, etc.)
        const returnQueue = liveData.queue.RETURN_TIME;
        if (returnQueue) {
          ride.hasLightningLane = true;
          ride.returnState = returnQueue.state;
          if (returnQueue.state === 'FINISHED') {
            ride.returnTime = 'Unavailable';
          } else if (returnQueue.state === 'TEMP_FULL') {
            ride.returnTime = 'Temporarily Full';
          } else if (returnQueue.state === 'AVAILABLE') {
            const returnDate = new Date(returnQueue.returnStart);
            ride.returnTime = returnDate.toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              timeZone: 'America/Los_Angeles'
            });
          }
        }
        
        // Check for PAID_RETURN_TIME queue (Lightning Lane, etc.)
        const paidReturnQueue = liveData.queue.PAID_RETURN_TIME;
        if (paidReturnQueue) {
          ride.hasLightningLane = true;
          ride.paidReturnState = paidReturnQueue.state;
          if (paidReturnQueue.state === 'FINISHED') {
            ride.paidReturnTime = 'Unavailable';
          } else if (paidReturnQueue.state === 'TEMP_FULL') {
            ride.paidReturnTime = 'Temporarily Full';
          } else if (paidReturnQueue.returnStart) {
            const paidReturnDate = new Date(paidReturnQueue.returnStart);
            ride.paidReturnTime = paidReturnDate.toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              timeZone: 'America/Los_Angeles'
            });
            ride.paidReturnPrice = paidReturnQueue.price?.formatted || '';
          }
        }

        // Check for SINGLE_RIDER queue
        const singleRiderQueue = liveData.queue.SINGLE_RIDER;
        if (singleRiderQueue) {
          ride.singleRiderWait = 'Offered';
        }
      }

      // Process forecast data if available
      if (liveData && liveData.forecast && liveData.forecast.length > 0) {
        const now = new Date();
        const currentHour = now.getHours();
        
        const currentForecast = liveData.forecast.find(f => {
          const forecastDate = new Date(f.time);
          return forecastDate.getHours() === currentHour;
        });
        
        const nextHourForecast = liveData.forecast.find(f => {
          const forecastDate = new Date(f.time);
          return forecastDate.getHours() === currentHour + 1;
        });
        
        const nextNextHourForecast = liveData.forecast.find(f => {
          const forecastDate = new Date(f.time);
          return forecastDate.getHours() === currentHour + 2;
        });
        
        if (currentForecast && currentForecast.waitTime !== null && currentForecast.waitTime !== undefined) {
          ride.avgWait = currentForecast.waitTime;
        }
        
        if (nextHourForecast) {
          const forecastDate1 = new Date(nextHourForecast.time);
          ride.forecastHour1 = forecastDate1.toLocaleTimeString('en-US', {
            hour: 'numeric',
            timeZone: 'America/Los_Angeles'
          });
          ride.forecastWait1 = nextHourForecast.waitTime;
        }
        
        if (nextNextHourForecast) {
          const forecastDate2 = new Date(nextNextHourForecast.time);
          ride.forecastHour2 = forecastDate2.toLocaleTimeString('en-US', {
            hour: 'numeric',
            timeZone: 'America/Los_Angeles'
          });
          ride.forecastWait2 = nextNextHourForecast.waitTime;
        }
      }

      if (!lands[landName]) {
        lands[landName] = [];
      }
      lands[landName].push(ride);
    }
    
    // Process SHOWS
    else if (entity.entityType === 'SHOW') {
      const show = {
        id: entity.id,
        name: entity.name,
        land: landName,
        status: 'CLOSED',
        showtimes: []
      };
      
      if (liveData) {
        show.status = liveData.status || 'CLOSED';
        
        if (liveData.showtimes && liveData.showtimes.length > 0) {
          show.showtimes = liveData.showtimes.map(st => ({
            startTime: st.startTime,
            endTime: st.endTime,
            type: st.type || 'Performance Time'
          }));
        }
      }
      
      // Only include shows with scheduled showtimes
      if (show.showtimes.length > 0) {
        if (!shows[landName]) {
          shows[landName] = [];
        }
        shows[landName].push(show);
      }
    }
    
    // Process RESTAURANTS
    else if (entity.entityType === 'RESTAURANT') {
      const restaurant = {
        id: entity.id,
        name: entity.name,
        land: landName,
        status: 'CLOSED'
      };
      
      if (liveData) {
        restaurant.status = liveData.status || 'CLOSED';
      }
      
      if (!restaurants[landName]) {
        restaurants[landName] = [];
      }
      restaurants[landName].push(restaurant);
    }
  });

  return { lands, shows, restaurants };
}

/**
 * Update cache for all parks
 */
async function updateParkDataCache() {
  console.log('Updating park data cache...');
  
  for (const [parkKey, parkId] of Object.entries(PARK_IDS)) {
    try {
      const parkData = await fetchParkData(parkId);
      const landMap = parkKey === 'disneyland' ? DISNEYLAND_LAND_MAP : DCA_LAND_MAP;
      const organized = organizeParkData(parkData, landMap);
      
      parkDataCache[parkKey] = {
        name: parkKey === 'disneyland' ? 'Disneyland Park' : 'Disney California Adventure',
        lands: organized.lands,
        shows: organized.shows,
        restaurants: organized.restaurants,
        lastUpdated: new Date().toISOString()
      };
      
      console.log(`✓ Updated ${parkKey} - ${Object.keys(organized.lands).length} lands, ${Object.keys(organized.shows).flat().length} shows`);
    } catch (error) {
      console.error(`✗ Failed to update ${parkKey}:`, error.message);
    }
  }
}

/**
 * Check for ready rides and send push notifications
 */
async function checkAndNotifyUsers() {
  console.log('Checking for ready rides and sending notifications...');
  
  const messages = [];
  
  for (const [userId, preferences] of Object.entries(userPreferences)) {
    const pushToken = userDeviceTokens[userId];
    
    if (!pushToken || !Expo.isExpoPushToken(pushToken)) {
      continue;
    }
    
    const readyRides = [];
    const currentReadyRideIds = new Set();
    
    Object.entries(parkDataCache).forEach(([parkKey, parkData]) => {
      Object.entries(parkData.lands).forEach(([landName, landRides]) => {
        landRides.forEach(ride => {
          const pref = preferences[ride.id];
          if (pref && pref.enabled &&
              ride.currentWait <= pref.maxWait &&
              (ride.status === 'OPERATING' || ride.status === 'DOWN')) {
            readyRides.push({
              ...ride,
              land: landName,
              park: parkData.name
            });
            currentReadyRideIds.add(ride.id);
          }
        });
      });
    });
    
    if (!notifiedRides[userId]) {
      notifiedRides[userId] = new Set();
    }
    
    const newReadyRides = readyRides.filter(ride =>
      !notifiedRides[userId].has(ride.id)
    );
    
    if (newReadyRides.length > 0) {
      const firstRide = newReadyRides[0];
      const rideCount = newReadyRides.length;
      
      let body;
      if (rideCount === 1) {
        body = `${firstRide.name} is now ${firstRide.currentWait} min wait!`;
      } else {
        body = `${firstRide.name} and ${rideCount - 1} other ride${rideCount > 2 ? 's are' : ' is'} ready!`;
      }
      
      messages.push({
        to: pushToken,
        sound: 'default',
        title: '🎢 Ride Ready!',
        body: body,
        data: {
          type: 'ride',
          rideCount: rideCount,
          rides: newReadyRides.map(r => r.name).join(', ')
        },
        priority: 'high',
        channelId: 'ride-alerts'
      });
      
      console.log(`📱 Queuing notification for user ${userId}: ${body}`);
    }
    
    notifiedRides[userId] = currentReadyRideIds;
  }
  
  // Send notifications
  await sendPushNotifications(messages);
}

/**
 * Check for show/dining/Lightning Lane reminders
 */
async function checkEventReminders() {
  console.log('Checking event reminders...');
  
  const now = new Date();
  const todayString = getTodayDateString();
  const messages = [];
  
  for (const [userId, schedulesByDate] of Object.entries(userShowSchedules)) {
    const pushToken = userDeviceTokens[userId];
    if (!pushToken || !Expo.isExpoPushToken(pushToken)) continue;
    
    const todayShows = schedulesByDate[todayString] || [];
    
    for (const show of todayShows) {
      const showTime = new Date(show.selectedTime);
      const reminderTime = new Date(showTime.getTime() - show.travelTime * 60000);
      const finalWarningTime = new Date(showTime.getTime() - 5 * 60000);
      
      // Main reminder
      if (now >= reminderTime && !show.notified) {
        messages.push({
          to: pushToken,
          sound: 'default',
          title: '🎭 Time to Head to Show!',
          body: `${show.showName} at ${showTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - Leave now!`,
          data: { type: 'show', showId: show.showId },
          priority: 'high',
          channelId: 'event-alerts'
        });
        show.notified = true;
        console.log(`📱 Show reminder for user ${userId}: ${show.showName}`);
      }
      
      // Final warning
      if (now >= finalWarningTime && !show.finalWarningNotified) {
        messages.push({
          to: pushToken,
          sound: 'default',
          title: '🎭 Show Starting Soon!',
          body: `${show.showName} starts in 5 minutes!`,
          data: { type: 'show-warning', showId: show.showId },
          priority: 'high',
          channelId: 'event-alerts'
        });
        show.finalWarningNotified = true;
        console.log(`📱 Show final warning for user ${userId}: ${show.showName}`);
      }
    }
  }
  
  // Check dining reminders
  for (const [userId, schedulesByDate] of Object.entries(userDiningSchedules)) {
    const pushToken = userDeviceTokens[userId];
    if (!pushToken || !Expo.isExpoPushToken(pushToken)) continue;
    
    const todayDining = schedulesByDate[todayString] || [];
    
    for (const dining of todayDining) {
      const diningTime = new Date(dining.time);
      const reminderTime = new Date(diningTime.getTime() - dining.travelTime * 60000);
      
      if (now >= reminderTime && !dining.notified) {
        messages.push({
          to: pushToken,
          sound: 'default',
          title: '🍽️ Dining Reminder!',
          body: `${dining.restaurantName} reservation at ${diningTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - Time to go!`,
          data: { type: 'dining', diningId: dining.id },
          priority: 'high',
          channelId: 'event-alerts'
        });
        dining.notified = true;
        console.log(`📱 Dining reminder for user ${userId}: ${dining.restaurantName}`);
      }
    }
  }
  
  // Check Lightning Lane reminders
  for (const [userId, lanesByDate] of Object.entries(userLightningLanes)) {
    const pushToken = userDeviceTokens[userId];
    if (!pushToken || !Expo.isExpoPushToken(pushToken)) continue;
    
    const todayLanes = lanesByDate[todayString] || {};
    
    for (const [rideId, lane] of Object.entries(todayLanes)) {
      const returnTime = new Date(lane.returnTime);
      const reminderTime = new Date(returnTime.getTime() - lane.travelTime * 60000);
      
      if (now >= reminderTime && !lane.notified) {
        messages.push({
          to: pushToken,
          sound: 'default',
          title: '⚡ Lightning Lane Time!',
          body: `Your Lightning Lane for ${lane.rideName} is at ${returnTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - Head over now!`,
          data: { type: 'lightning-lane', rideId: rideId },
          priority: 'high',
          channelId: 'event-alerts'
        });
        lane.notified = true;
        console.log(`📱 Lightning Lane reminder for user ${userId}: ${lane.rideName}`);
      }
    }
  }
  
  await sendPushNotifications(messages);
}

/**
 * Send push notifications in chunks
 */
async function sendPushNotifications(messages) {
  if (messages.length === 0) return;
  
  const chunks = expo.chunkPushNotifications(messages);
  
  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      console.log(`✓ Sent ${ticketChunk.length} notifications`);
      
      ticketChunk.forEach((ticket, index) => {
        if (ticket.status === 'error') {
          console.error(`✗ Error sending notification: ${ticket.message}`);
          if (ticket.details && ticket.details.error === 'DeviceNotRegistered') {
            const message = chunk[index];
            Object.entries(userDeviceTokens).forEach(([userId, token]) => {
              if (token === message.to) {
                delete userDeviceTokens[userId];
                console.log(`Removed invalid token for user ${userId}`);
              }
            });
          }
        }
      });
    } catch (error) {
      console.error('✗ Error sending push notifications:', error);
    }
  }
}

/**
 * Auto-archive past dates (runs daily at midnight PST)
 */
function autoArchivePastDates() {
  console.log('Auto-archiving past dates...');
  const today = getTodayDateString();
  
  for (const [userId, schedulesByDate] of Object.entries(userShowSchedules)) {
    for (const [date, shows] of Object.entries(schedulesByDate)) {
      if (date < today) {
        if (!archivedSchedules[userId]) archivedSchedules[userId] = {};
        archivedSchedules[userId][date] = {
          shows: shows,
          dining: userDiningSchedules[userId]?.[date] || [],
          lightningLanes: userLightningLanes[userId]?.[date] || {}
        };
        
        delete userShowSchedules[userId][date];
        if (userDiningSchedules[userId]) delete userDiningSchedules[userId][date];
        if (userLightningLanes[userId]) delete userLightningLanes[userId][date];
        
        console.log(`Archived ${date} for user ${userId}`);
      }
    }
  }
}

/**
 * Helper: Get today's date string in YYYY-MM-DD format (PST)
 */
function getTodayDateString() {
  const now = new Date();
  const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return pst.toISOString().split('T')[0];
}

/**
 * Helper: Generate unique ID
 */
function generateId() {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * API Routes
 */

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cacheStatus: {
      disneyland: parkDataCache.disneyland.lastUpdated,
      californiaadventure: parkDataCache.californiaadventure.lastUpdated
    }
  });
});

// Get all parks
app.get('/api/parks', (req, res) => {
  res.json({
    parks: [
      { id: 'disneyland', name: 'Disneyland Park' },
      { id: 'californiaadventure', name: 'Disney California Adventure' }
    ]
  });
});

// Get wait times for a specific park
app.get('/api/parks/:parkId/wait-times', (req, res) => {
  const { parkId } = req.params;
  
  if (!parkDataCache[parkId]) {
    return res.status(404).json({ error: 'Park not found' });
  }

  const parkData = parkDataCache[parkId];
  
  const rides = [];
  Object.entries(parkData.lands).forEach(([landName, landRides]) => {
    landRides.forEach(ride => {
      rides.push({
        ...ride,
        land: landName
      });
    });
  });

  res.json({
    park: parkData.name,
    lands: parkData.lands,
    rides: rides,
    lastUpdated: parkData.lastUpdated
  });
});

// Get shows for a specific park
app.get('/api/parks/:parkId/shows', (req, res) => {
  const { parkId } = req.params;
  
  if (!parkDataCache[parkId]) {
    return res.status(404).json({ error: 'Park not found' });
  }

  res.json({
    park: parkDataCache[parkId].name,
    shows: parkDataCache[parkId].shows,
    lastUpdated: parkDataCache[parkId].lastUpdated
  });
});

// Get restaurants for a specific park
app.get('/api/parks/:parkId/restaurants', (req, res) => {
  const { parkId } = req.params;
  
  if (!parkDataCache[parkId]) {
    return res.status(404).json({ error: 'Park not found' });
  }

  res.json({
    park: parkDataCache[parkId].name,
    restaurants: parkDataCache[parkId].restaurants,
    lastUpdated: parkDataCache[parkId].lastUpdated
  });
});

// NEW DISNEY DINING ENDPOINT - ADD THIS
//app.get('/api/parks/:parkId/disney-dining', (req, res) => {
//  try {
//    const { parkId } = req.params;
//    const data = disneyDiningService.getCachedData();
//
//    const restaurants = parkId === 'disneyland'
//      ? data.disneyland
//      : data.californiaAdventure;
//
//    res.json({
//      restaurants,
//      lastUpdate: disneyDiningService.lastUpdate,
//      source: 'Disney Official API'
//    });
//  } catch (error) {
//    console.error('Error getting Disney dining:', error);
//    res.status(500).json({ error: 'Failed to get dining data' });
//  }
//});

// Update the endpoint
app.get('/api/parks/:parkId/enhanced-dining', (req, res) => {
  try {
    const { parkId } = req.params;
    const data = hybridDiningService.getCachedData();
    
    const restaurants = parkId === 'disneyland'
      ? data.disneyland
      : data.californiaAdventure;
    
    res.json({
      restaurants,
      lastUpdate: hybridDiningService.lastUpdate,
      source: 'Hybrid (ThemeParks.wiki + Enhanced Scraping)'
    });
  } catch (error) {
    console.error('Error getting enhanced dining:', error);
    res.status(500).json({ error: 'Failed to get dining data' });
  }
});

// Get rides with Lightning Lane
app.get('/api/parks/lightning-lane-rides', (req, res) => {
  const ridesWithLL = [];
  
  Object.entries(parkDataCache).forEach(([parkKey, parkData]) => {
    Object.entries(parkData.lands).forEach(([landName, landRides]) => {
      landRides.forEach(ride => {
        if (ride.hasLightningLane) {
          ridesWithLL.push({
            ...ride,
            land: landName,
            park: parkData.name,
            parkId: parkKey
          });
        }
      });
    });
  });
  
  res.json({ rides: ridesWithLL });
});

// Save user preferences (rides)
app.post('/api/users/:userId/preferences', (req, res) => {
  const { userId } = req.params;
  const { preferences } = req.body;

  userPreferences[userId] = preferences;

  res.json({
    success: true,
    message: 'Preferences saved',
    userId: userId
  });
});

// Get user preferences
app.get('/api/users/:userId/preferences', (req, res) => {
  const { userId } = req.params;
  
  res.json({
    preferences: userPreferences[userId] || {}
  });
});

// Get rides that meet user's criteria
app.get('/api/users/:userId/ready-rides', (req, res) => {
  const { userId } = req.params;
  const preferences = userPreferences[userId];

  if (!preferences) {
    return res.json({ readyRides: [] });
  }

  const readyRides = [];

  Object.entries(parkDataCache).forEach(([parkKey, parkData]) => {
    Object.entries(parkData.lands).forEach(([landName, landRides]) => {
      landRides.forEach(ride => {
        const pref = preferences[ride.id];
        if (pref && pref.enabled && ride.currentWait <= pref.maxWait &&
            (ride.status === 'OPERATING' || ride.status === 'DOWN')) {
          readyRides.push({
            ...ride,
            land: landName,
            park: parkData.name
          });
        }
      });
    });
  });

  res.json({
    readyRides: readyRides,
    timestamp: new Date().toISOString()
  });
});

// Register device for push notifications
app.post('/api/users/:userId/register-device', (req, res) => {
  const { userId } = req.params;
  const { pushToken } = req.body;

  if (!pushToken) {
    return res.status(400).json({ error: 'Push token required' });
  }

  if (!Expo.isExpoPushToken(pushToken)) {
    return res.status(400).json({ error: 'Invalid push token format' });
  }

  userDeviceTokens[userId] = pushToken;
  
  if (!notifiedRides[userId]) {
    notifiedRides[userId] = new Set();
  }

  res.json({
    success: true,
    message: 'Device registered for push notifications',
    userId: userId
  });
});

// Unregister device
app.post('/api/users/:userId/unregister-device', (req, res) => {
  const { userId } = req.params;
  
  delete userDeviceTokens[userId];
  delete notifiedRides[userId];

  res.json({
    success: true,
    message: 'Device unregistered'
  });
});

// Add show to schedule
app.post('/api/users/:userId/shows', (req, res) => {
  const { userId } = req.params;
  const { date, showId, showName, selectedTime, travelTime } = req.body;
  
  if (!date || !showId || !showName || !selectedTime || travelTime === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  if (!userShowSchedules[userId]) {
    userShowSchedules[userId] = {};
  }
  
  if (!userShowSchedules[userId][date]) {
    userShowSchedules[userId][date] = [];
  }
  
  userShowSchedules[userId][date].push({
    showId,
    showName,
    selectedTime,
    travelTime,
    notified: false,
    finalWarningNotified: false
  });
  
  res.json({
    success: true,
    message: 'Show added to schedule'
  });
});

// Get user's show schedule
app.get('/api/users/:userId/shows', (req, res) => {
  const { userId } = req.params;
  const { date } = req.query;
  
  if (date) {
    const shows = userShowSchedules[userId]?.[date] || [];
    return res.json({ shows });
  }
  
  res.json({ schedules: userShowSchedules[userId] || {} });
});

// Delete show from schedule
app.delete('/api/users/:userId/shows/:showId', (req, res) => {
  const { userId, showId } = req.params;
  const { date } = req.query;
  
  if (!date || !userShowSchedules[userId]?.[date]) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  
  userShowSchedules[userId][date] = userShowSchedules[userId][date].filter(
    show => show.showId !== showId
  );
  
  res.json({ success: true, message: 'Show removed from schedule' });
});

// Add dining reservation
app.post('/api/users/:userId/dining', (req, res) => {
  const { userId } = req.params;
  const { date, restaurantName, time, type, travelTime } = req.body;
  
  if (!date || !restaurantName || !time || !type || travelTime === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  if (!userDiningSchedules[userId]) {
    userDiningSchedules[userId] = {};
  }
  
  if (!userDiningSchedules[userId][date]) {
    userDiningSchedules[userId][date] = [];
  }
  
  const diningId = generateId();
  
  userDiningSchedules[userId][date].push({
    id: diningId,
    restaurantName,
    time,
    type,
    travelTime,
    notified: false
  });
  
  res.json({
    success: true,
    message: 'Dining reservation added',
    diningId
  });
});

// Get user's dining schedule
app.get('/api/users/:userId/dining', (req, res) => {
  const { userId } = req.params;
  const { date } = req.query;
  
  if (date) {
    const dining = userDiningSchedules[userId]?.[date] || [];
    return res.json({ dining });
  }
  
  res.json({ schedules: userDiningSchedules[userId] || {} });
});

// Update dining reservation
app.put('/api/users/:userId/dining/:diningId', (req, res) => {
  const { userId, diningId } = req.params;
  const { date, time, type, travelTime } = req.body;
  
  if (!date || !userDiningSchedules[userId]?.[date]) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  
  const dining = userDiningSchedules[userId][date].find(d => d.id === diningId);
  
  if (!dining) {
    return res.status(404).json({ error: 'Dining reservation not found' });
  }
  
  if (time) dining.time = time;
  if (type) dining.type = type;
  if (travelTime !== undefined) dining.travelTime = travelTime;
  dining.notified = false; // Reset notification
  
  res.json({ success: true, message: 'Dining reservation updated' });
});

// Delete dining reservation
app.delete('/api/users/:userId/dining/:diningId', (req, res) => {
  const { userId, diningId } = req.params;
  const { date } = req.query;
  
  if (!date || !userDiningSchedules[userId]?.[date]) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  
  userDiningSchedules[userId][date] = userDiningSchedules[userId][date].filter(
    d => d.id !== diningId
  );
  
  res.json({ success: true, message: 'Dining reservation removed' });
});

// Add Lightning Lane time
app.post('/api/users/:userId/lightning-lane', (req, res) => {
  const { userId } = req.params;
  const { date, rideId, rideName, returnTime, travelTime } = req.body;
  
  if (!date || !rideId || !rideName || !returnTime || travelTime === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  if (!userLightningLanes[userId]) {
    userLightningLanes[userId] = {};
  }
  
  if (!userLightningLanes[userId][date]) {
    userLightningLanes[userId][date] = {};
  }
  
  userLightningLanes[userId][date][rideId] = {
    rideName,
    returnTime,
    travelTime,
    notified: false
  };
  
  res.json({
    success: true,
    message: 'Lightning Lane time added'
  });
});

// Get user's Lightning Lane schedule
app.get('/api/users/:userId/lightning-lane', (req, res) => {
  const { userId } = req.params;
  const { date } = req.query;
  
  if (date) {
    const lightningLanes = userLightningLanes[userId]?.[date] || {};
    return res.json({ lightningLanes });
  }
  
  res.json({ schedules: userLightningLanes[userId] || {} });
});

// Delete Lightning Lane time
app.delete('/api/users/:userId/lightning-lane/:rideId', (req, res) => {
  const { userId, rideId } = req.params;
  const { date } = req.query;
  
  if (!date || !userLightningLanes[userId]?.[date]) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  
  delete userLightningLanes[userId][date][rideId];
  
  res.json({ success: true, message: 'Lightning Lane time removed' });
});

// Get user's archives
app.get('/api/users/:userId/archives', (req, res) => {
  const { userId } = req.params;
  
  res.json({ archives: archivedSchedules[userId] || {} });
});

// Delete archived date
app.delete('/api/users/:userId/archives/:date', (req, res) => {
  const { userId, date } = req.params;
  
  if (!archivedSchedules[userId]?.[date]) {
    return res.status(404).json({ error: 'Archive not found' });
  }
  
  delete archivedSchedules[userId][date];
  
  res.json({ success: true, message: 'Archive deleted' });
});

// Manual refresh endpoint
app.post('/api/refresh', async (req, res) => {
  try {
    await updateParkDataCache();
    res.json({
      success: true,
      message: 'Cache updated',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// DEBUG: Check registered devices (REMOVE IN PRODUCTION)
app.get('/api/debug/devices', (req, res) => {
  res.json({
    registeredDevices: Object.keys(userDeviceTokens).length,
    deviceTokens: Object.keys(userDeviceTokens),
    userPreferences: Object.keys(userPreferences),
  });
});

// DEBUG: Manually trigger notification check (REMOVE IN PRODUCTION)
app.post('/api/debug/check-notifications', async (req, res) => {
  try {
    await checkAndNotifyUsers();
    await checkEventReminders();
    res.json({
      success: true,
      message: 'Notification check triggered',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Disney Dining Endpoint - Simplified Data
app.get('/api/parks/:parkId/dining', (req, res) => {
  try {
    const { parkId } = req.params;
    const data = diningService.getCachedData();
    
    const restaurants = parkId === 'disneyland'
      ? data.disneyland
      : data.californiaAdventure;
    
    res.json({
      restaurants,
      lastScrape: diningService.lastScrape,
      source: 'Disney Official API (via Puppeteer)'
    });
  } catch (error) {
    console.error('Error getting dining data:', error);
    res.status(500).json({ error: 'Failed to get dining data' });
  }
});

// Disney Shows Endpoint - Simplified Data
app.get('/api/parks/:parkId/shows', (req, res) => {
  try {
    const { parkId } = req.params;
    const data = showsService.getCachedData();
    
    const shows = parkId === 'disneyland'
      ? data.disneyland
      : data.californiaAdventure;
    
    res.json({
      shows,
      lastScrape: showsService.lastScrape,
      source: 'Disney Official API (via Puppeteer)'
    });
  } catch (error) {
    console.error('Error getting shows data:', error);
    res.status(500).json({ error: 'Failed to get shows data' });
  }
});

/**
 * Initialize and start server
 */
async function startServer() {
  console.log('Performing initial data fetch...');
  await updateParkDataCache();
  
  // Fetch Disney dining data in background (don't block startup)
  console.log('Starting Disney dining data scraper in background...');
  diningService.scrapeDiningData().catch(err => {
    console.error('Dining scraper error:', err);
  });
  
  // Fetch Disney shows data in background (don't block startup)
  console.log('Starting Disney shows data scraper in background...');
  showsService.scrapeShowsData().catch(err => {
    console.error('Shows scraper error:', err);
  });
    
  // Schedule park data updates every 1 minute
  cron.schedule('*/1 * * * *', () => {
    console.log('Scheduled update triggered');
    updateParkDataCache().then(() => {
      checkAndNotifyUsers();
      checkEventReminders();
    });
  });
  
  // Auto-archive past dates daily at midnight PST
  cron.schedule('0 0 * * *', () => {
    console.log('Daily archive task triggered');
    autoArchivePastDates();
  }, {
    timezone: 'America/Los_Angeles'
  });
    
    // Update Disney dining data daily at 2 AM PST
    cron.schedule('0 2 * * *', () => {
      console.log('Daily Disney dining data refresh triggered');
      diningService.scrapeDiningData();
    }, {
      timezone: 'America/Los_Angeles'
    });
    
// Update Disney dining data daily at 2 AM PST
//    cron.schedule('0 2 * * *', () => {
//      console.log('Daily Disney dining data refresh triggered');
//      disneyDiningService.fetchDiningForDate();
//    }, {
//      timezone: 'America/Los_Angeles'
//    });
    
// Update Disney shows data daily at 2:30 AM PST - ADD THIS
    cron.schedule('30 2 * * *', () => {
      console.log('Daily Disney shows data refresh triggered');
      showsService.scrapeShowsData();
    }, {
      timezone: 'America/Los_Angeles'
    });
    
  app.listen(PORT, () => {
    console.log(`
    🎢 Ride Wait Monitor API Server
    ================================
    Server running on port ${PORT}
    
    Parks:
    - Disneyland Park
    - Disney California Adventure
    
    Features:
    - Ride wait times & notifications
    - Show scheduling & reminders
    - Dining reservations & reminders
    - Lightning Lane tracking
    - Multi-day planning
    - Auto-archiving
    
    Data updates every minute
    Archives past dates at midnight PST
    `);
  });
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

// Start the server
startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

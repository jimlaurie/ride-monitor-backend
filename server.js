const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cron = require('node-cron');
// const nodemailer = require('nodemailer');
// const { Parser } = require('@json2csv/plainjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory cache for wait times
let parkDataCache = {
  disneyland: { lands: {}, lastUpdated: null },
  californiaadventure: { lands: {}, lastUpdated: null }
};

// User preferences storage (in production, use a database)
let userPreferences = {};

// Daily data collection storage
let dailyDataCollection = [];

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
    // Get live wait times
    const liveDataResponse = await axios.get(
      `${THEMEPARKS_API}/entity/${parkId}/live`,
      { timeout: 10000 }
    );

    // Get park children (rides)
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
 * Process and organize park data into lands
 */
function organizeParkData(parkData, landMap) {
  const lands = {};
  
  if (!parkData.children || !parkData.children.children) {
    return lands;
  }

  parkData.children.children.forEach(entity => {
    // Only process attractions
    if (entity.entityType !== 'ATTRACTION') return;

    // Find live data for this entity
    const liveData = parkData.liveData.liveData?.find(
      live => live.id === entity.id
    );

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

    // Create ride object
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
      paidStandbyWait: null
    };

    // Add live wait time if available
    if (liveData && liveData.queue) {
      const standbyQueue = liveData.queue.STANDBY;
      if (standbyQueue) {
        ride.currentWait = standbyQueue.waitTime || 0;
      }
      
      // Map status from API
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
      
      // Check for RETURN_TIME queue (Lightning Lane, etc.)
      const returnQueue = liveData.queue.RETURN_TIME;
      if (returnQueue) {
          ride.returnState = returnQueue.state;
          if (returnQueue.state === 'FINISHED') {
              ride.returnTime = 'Unavailable';
          } else if (returnQueue.state === 'TEMP_FULL') {
              ride.returnTime = 'Temporarily Full';
          } else if (returnQueue.returnEnd) {
          // Convert to local time
          const returnDate = new Date(returnQueue.returnEnd);
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
            ride.paidReturnState = paidReturnQueue.state;
            if (paidReturnQueue.state === 'FINISHED') {
                ride.paidReturnTime = 'Unavailable';
            } else if (paidReturnQueue.state === 'TEMP_FULL') {
                ride.paidReturnTime = 'Temporarily Full';
            } else if (paidReturnQueue.returnEnd) {
            // Convert to local time
            const paidReturnDate = new Date(paidReturnQueue.returnEnd);
            ride.paidReturnTime = paidReturnDate.toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              timeZone: 'America/Los_Angeles'
            });
          }
        }

      // Check for SINGLE_RIDER queue
      const singleRiderQueue = liveData.queue.SINGLE_RIDER;
      if (singleRiderQueue && singleRiderQueue.waitTime !== null && singleRiderQueue.waitTime !== undefined) {
        ride.singleRiderWait = singleRiderQueue.waitTime;
      }
    }

    // Initialize land if needed
    if (!lands[landName]) {
      lands[landName] = [];
    }

    lands[landName].push(ride);
  });

  return lands;
}

/**
 * Collect data point for daily CSV
 */
function collectDataPoint() {
  const now = new Date();
  const pstTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const hour = pstTime.getHours();
  
  // Only collect between 7am and 12pm PST
  if (hour < 7 || hour >= 24) {
    return;
  }
  
  const timestamp = pstTime.toISOString();
  
  // Collect data from both parks
  Object.entries(parkDataCache).forEach(([parkKey, parkData]) => {
    if (!parkData.lands) return;
    
    Object.entries(parkData.lands).forEach(([landName, rides]) => {
      rides.forEach(ride => {
        dailyDataCollection.push({
          timestamp: timestamp,
          date: pstTime.toLocaleDateString('en-US'),
          time: pstTime.toLocaleTimeString('en-US'),
          parkName: parkData.name,
          landName: landName,
          rideId: ride.id,
          rideName: ride.name,
          currentWait: ride.currentWait || 0,
          averageWait: ride.avgWait || 0,
          status: ride.status || 'UNKNOWN',
          returnTime: ride.returnTime || null,
          returnState: ride.returnState || null,
          singleRiderWait: ride.singleRiderWait || 0,
          paidReturnState: ride.paidReturnState || null,
          paidReturnTime: ride.paidReturnTime || null,
          paidReturnPrice: ride.paidReturnPrice || null,
          paidStandbyWait: ride.paidStandbyWait || null
        });
      });
    });
  });
  
  console.log(`📊 Collected data point at ${pstTime.toLocaleTimeString('en-US')} PST - Total records: ${dailyDataCollection.length}`);
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
      const lands = organizeParkData(parkData, landMap);
      
      parkDataCache[parkKey] = {
        name: parkKey === 'disneyland' ? 'Disneyland Park' : 'Disney California Adventure',
        lands: lands,
        lastUpdated: new Date().toISOString()
      };
      
      console.log(`✓ Updated ${parkKey} - ${Object.keys(lands).length} lands`);
    } catch (error) {
      console.error(`✗ Failed to update ${parkKey}:`, error.message);
    }
  }
  
  // Collect data point after updating
//  collectDataPoint();
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
  
  // Convert lands object to array format
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

// Save user preferences
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

  // Check all parks
  Object.entries(parkDataCache).forEach(([parkKey, parkData]) => {
    Object.entries(parkData.lands).forEach(([landName, landRides]) => {
      landRides.forEach(ride => {
        const pref = preferences[ride.id];
        if (pref && pref.enabled && ride.currentWait <= pref.maxWait && ride.status === 'OPERATING') {
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

// Manual refresh endpoint (for testing)
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

/**
 * Initialize and start server
 */
async function startServer() {
  // Initial data fetch
  console.log('Performing initial data fetch...');
  await updateParkDataCache();

  // Schedule updates every 1 minute
  cron.schedule('*/1 * * * *', () => {
    console.log('Scheduled update triggered');
    updateParkDataCache();
  });
  
  // Email daily report at 11:30 PM PST (7:30 AM UTC next day)
  // cron.schedule('30 7 * * *', () => {
  //   console.log('Sending daily report...');
  //   emailDailyReport();
  // }, {
  //   timezone: 'America/Los_Angeles'
  // });

  app.listen(PORT, () => {
    console.log(`
    🎢 Ride Wait Monitor API Server
    ================================
    Server running on port ${PORT}
    
    Endpoints:
    - GET  /health
    - GET  /api/parks
    - GET  /api/parks/:parkId/wait-times
    - POST /api/users/:userId/preferences
    - GET  /api/users/:userId/preferences
    - GET  /api/users/:userId/ready-rides
    - POST /api/refresh
    
    Data updates every 5 minutes automatically
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

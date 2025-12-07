// hybridDiningService.js
const axios = require('axios');
const puppeteerScraper = require('./puppeteerDiningScraper');

class HybridDiningService {
  constructor() {
    this.realtimeData = { disneyland: {}, californiaAdventure: {} };
    this.enhancedData = { disneyland: {}, californiaAdventure: {} };
    this.lastUpdate = null;
  }

  async initialize() {
    console.log('🔄 Initializing hybrid dining service...');
    
    // Load enhanced data from file or scrape if needed
    if (puppeteerScraper.shouldScrape()) {
      console.log('⏰ Enhanced data is stale, will scrape soon...');
      // Don't block startup, scrape in background
      this.scrapeEnhancedData();
    } else {
      this.enhancedData = await puppeteerScraper.loadFromFile();
    }

    // Fetch real-time data from ThemeParks.wiki
    // Skip real-time - ThemeParks.wiki doesn't have restaurant data
    //     await this.fetchRealtimeData();
      
      this.realtimeData = { disneyland: {}, californiaadventure: {} }; // Empty for now
  }

    async fetchRealtimeData() {
      try {
        console.log('📡 Fetching real-time dining data from ThemeParks.wiki...');
        
        // Get all entities for both parks
        const [dlRes, dcaRes] = await Promise.all([
          axios.get('https://api.themeparks.wiki/v1/entity/7340550b-c14d-4def-80bb-acdb51d49a66/live'),
          axios.get('https://api.themeparks.wiki/v1/entity/832fcd51-ea34-4e5a-8a72-c174ad8db8cb/live')
        ]);

        // Filter for restaurants from live data
        const dlDining = (dlRes.data.liveData || []).filter(e =>
          e.entityType === 'RESTAURANT' || e.entityType === 'DINING'
        );
        const dcaDining = (dcaRes.data.liveData || []).filter(e =>
          e.entityType === 'RESTAURANT' || e.entityType === 'DINING'
        );

        console.log(`  Found ${dlDining.length} Disneyland restaurants`);
        console.log(`  Found ${dcaDining.length} DCA restaurants`);

        this.realtimeData = {
          disneyland: this.organizeByLand(dlDining, 'disneyland'),
          californiaadventure: this.organizeByLand(dcaDining, 'californiaadventure')
        };

        this.lastUpdate = new Date();
        console.log(`✅ Total: ${dlDining.length + dcaDining.length} restaurants from ThemeParks.wiki`);

      } catch (error) {
        console.error('❌ Error fetching real-time data:', error.message);
        console.log('  Continuing without real-time data...');
        // Don't crash, just continue without it
        this.realtimeData = { disneyland: {}, californiaadventure: {} };
      }
    }

  organizeByLand(restaurants, parkKey) {
    const organized = {};
    
    restaurants.forEach(restaurant => {
      const land = 'Other'; // Use your parkMappings here
      if (!organized[land]) organized[land] = [];
      
      organized[land].push({
        id: restaurant.id,
        name: restaurant.name,
        status: restaurant.status || 'OPERATING'
      });
    });

    return organized;
  }

  async scrapeEnhancedData() {
    try {
      console.log('🎭 Starting weekly enhanced data scrape...');
      this.enhancedData = await puppeteerScraper.scrapeEnhancedDiningData();
    } catch (error) {
      console.error('❌ Error in enhanced scraping:', error);
    }
  }

  getMergedData(parkId) {
    const realtime = this.realtimeData[parkId] || {};
    const enhanced = this.enhancedData[parkId] || {};

    // Merge: Start with enhanced data, overlay real-time status
    const merged = {};

    Object.keys(enhanced).forEach(land => {
      merged[land] = enhanced[land].map(restaurant => ({
        ...restaurant,
        // Add real-time status if available
        status: this.getRealtimeStatus(restaurant.id, realtime) || 'OPERATING'
      }));
    });

    // Add any restaurants from realtime that aren't in enhanced
    Object.keys(realtime).forEach(land => {
      if (!merged[land]) merged[land] = [];
      
      realtime[land].forEach(rtRestaurant => {
        const exists = merged[land].some(r => r.id === rtRestaurant.id);
        if (!exists) {
          merged[land].push(rtRestaurant);
        }
      });
    });

    return merged;
  }

  getRealtimeStatus(restaurantId, realtimeData) {
    for (const land of Object.values(realtimeData)) {
      const restaurant = land.find(r => r.id === restaurantId);
      if (restaurant) return restaurant.status;
    }
    return null;
  }

  getCachedData() {
    return {
      disneyland: this.getMergedData('disneyland'),
      californiaAdventure: this.getMergedData('californiaAdventure')
    };
  }
}

module.exports = new HybridDiningService();

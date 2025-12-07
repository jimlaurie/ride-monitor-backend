// disneyDiningService.js
const axios = require('axios');

const DISNEY_API_BASE = 'https://disneyland.disney.go.com/finder/api/v1/explorer-service';

class DisneyDiningService {
  constructor() {
    this.cache = {
      disneyland: {},
      californiaAdventure: {}
    };
    this.lastUpdate = null;
    this.conversationId = this.generateUUID();
  }

  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  async fetchDiningForDate(date) {
    try {
      const dateStr = date || this.getTodayDate();
      const url = `${DISNEY_API_BASE}/list-ancestor-entities/dlr/80008297;entityType=destination/${dateStr}/dining`;
      
      console.log(`📡 Fetching Disney dining data for ${dateStr}...`);
      
      const response = await axios.get(url, {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'en_US',
          'referer': 'https://disneyland.disney.go.com/dining/',
          'sec-ch-ua': '"Chromium";v="120", "Google Chrome";v="120", "Not_A Brand";v="99"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'x-conversation-id': this.conversationId,
          'x-correlation-id': this.generateUUID(),
          'x-disney-analytics-page-key': 'dlr.dining'
        },
        timeout: 15000,
        validateStatus: function (status) {
          return status >= 200 && status < 500; // Don't throw on 4xx errors
        }
      });

      if (response.status === 401) {
        console.log('⚠️  API returned 401 - Using fallback to ThemeParks.wiki');
        return this.cache; // Return cached data
      }

      if (response.status !== 200) {
        console.log(`⚠️  API returned status ${response.status}`);
        return this.cache;
      }

      const restaurants = response.data.results || [];
      
      if (restaurants.length === 0) {
        console.log('⚠️  No restaurants returned from API');
        return this.cache;
      }
      
      // Organize by park
      const organized = this.organizeDiningByPark(restaurants);
      
      this.cache = organized;
      this.lastUpdate = new Date();
      
      console.log(`✅ Fetched ${restaurants.length} dining locations`);
      console.log(`   - Disneyland: ${Object.values(organized.disneyland).flat().length} restaurants`);
      console.log(`   - DCA: ${Object.values(organized.californiaAdventure).flat().length} restaurants`);
      
      return organized;
      
    } catch (error) {
      console.error('❌ Error fetching Disney dining data:', error.message);
      console.log('   Using cached/fallback data');
      return this.cache;
    }
  }

  organizeDiningByPark(restaurants) {
    const disneyland = {};
    const californiaAdventure = {};

    restaurants.forEach(restaurant => {
      const parkName = restaurant.locationName;
      const landName = 'Other'; // We'll enhance this later with proper mapping
      
      const restaurantData = {
        id: restaurant.facilityId,
        name: restaurant.name,
        type: restaurant.facetGroupType || 'Dining',
        quickService: restaurant.quickServiceAvailable || false,
        mobileOrder: restaurant.facets?.mobileOrder?.length > 0 || false,
        maxPartySize: parseInt(restaurant.maximumPartySize) || null,
        hours: this.formatHours(restaurant.openHours),
        reservationUrl: restaurant.remyCheckAvailCta?.href
          ? `https://disneyland.disney.go.com${restaurant.remyCheckAvailCta.href}`
          : null,
        menuUrl: restaurant.url
          ? `https://disneyland.disney.go.com${restaurant.url}`
          : null,
        coordinates: restaurant.restaurants?.[0]?.coordinates?.['Guest Entrance']?.gps || null,
        status: restaurant.openHours?.length > 0 ? 'OPERATING' : 'CLOSED',
        cuisineTypes: restaurant.type?.facets || '',
        priceRange: this.extractPriceRange(restaurant)
      };

      // Determine which park
      if (parkName?.includes('Disneyland Park')) {
        if (!disneyland[landName]) disneyland[landName] = [];
        disneyland[landName].push(restaurantData);
      } else if (parkName?.includes('California Adventure')) {
        if (!californiaAdventure[landName]) californiaAdventure[landName] = [];
        californiaAdventure[landName].push(restaurantData);
      }
    });

    // Sort restaurants within each land alphabetically
    Object.keys(disneyland).forEach(land => {
      disneyland[land].sort((a, b) => a.name.localeCompare(b.name));
    });
    Object.keys(californiaAdventure).forEach(land => {
      californiaAdventure[land].sort((a, b) => a.name.localeCompare(b.name));
    });

    return { disneyland, californiaAdventure };
  }

  formatHours(openHours) {
    if (!openHours || openHours.length === 0) return 'Closed';
    
    const hours = openHours.map(h => {
      if (h.startTime && h.endTime) {
        return `${h.startTime} - ${h.endTime}`;
      }
      return null;
    }).filter(Boolean);
    
    return hours.length > 0 ? hours.join(', ') : 'Check Disney app';
  }

  extractPriceRange(restaurant) {
    return null;
  }

  getTodayDate() {
    const today = new Date();
    return today.toISOString().split('T')[0];
  }

  getCachedData() {
    return this.cache;
  }

  isCacheStale() {
    if (!this.lastUpdate) return true;
    const hoursSinceUpdate = (Date.now() - this.lastUpdate.getTime()) / (1000 * 60 * 60);
    return hoursSinceUpdate > 24;
  }
}

module.exports = new DisneyDiningService();

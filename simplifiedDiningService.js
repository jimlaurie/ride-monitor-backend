// simplifiedDiningService.js
const axios = require('axios');
const fs = require('fs').promises;

const DISNEY_API_BASE = 'https://disneyland.disney.go.com/finder/api/v1/explorer-service';

class SimplifiedDiningService {
  constructor() {
    this.cache = {
      disneyland: {},
      californiaAdventure: {}
    };
    this.lastUpdate = null;
  }

  async fetchDiningData(date) {
    try {
      const dateStr = date || this.getTodayDate();
      const url = `${DISNEY_API_BASE}/list-ancestor-entities/dlr/80008297;entityType=destination/${dateStr}/dining`;
      
      console.log(`🍽️  Fetching Disney dining data for ${dateStr}...`);
      
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://disneyland.disney.go.com/dining/'
        },
        timeout: 15000
      });

      if (response.status !== 200) {
        console.log(`⚠️  API returned status ${response.status}`);
        return this.loadFromCache();
      }

      const restaurants = response.data.results || [];
      console.log(`✅ Fetched ${restaurants.length} restaurants from Disney API`);
      
      // Process and organize data
      this.cache = this.organizeRestaurants(restaurants, dateStr);
      this.lastUpdate = new Date();
      
      // Save to file
      await this.saveToFile();
      
      return this.cache;
      
    } catch (error) {
      console.error('❌ Error fetching Disney dining data:', error.message);
      return this.loadFromCache();
    }
  }

  organizeRestaurants(restaurants, date) {
    const disneyland = {};
    const californiaAdventure = {};

    restaurants.forEach(restaurant => {
      // Extract the data we want
      const data = {
        id: restaurant.facilityId || restaurant.id,
        name: restaurant.name,
        
        // Location
        locationName: restaurant.locationName,
        land: this.extractLandFromLocation(restaurant.locationName),
        coordinates: restaurant.marker ? {
          lat: restaurant.marker.lat,
          lng: restaurant.marker.lng
        } : null,
        
        // Type & Pricing
        serviceType: restaurant.facetGroupType || 'Dining',
        cuisineType: restaurant.type?.facets || '',
        priceRange: this.extractPriceRange(restaurant.facets?.priceRange),
        
        // Hours
        hours: this.extractHours(restaurant.schedule, date),
        isClosed: this.checkIfClosed(restaurant.schedule, date),
        
        // Links
        menuLink: restaurant.webLinks?.dlrDetails?.href
          ? `https://disneyland.disney.go.com${restaurant.webLinks.dlrDetails.href}`
          : null,
        
        // Features
        mobileOrder: this.hasMobileOrder(restaurant.facets || {}),
        acceptsReservations: this.acceptsReservations(restaurant),
        
        // Status
        status: this.getStatus(restaurant)
      };

      // Organize by park
      if (data.locationName?.includes('Disneyland Park')) {
        if (!disneyland[data.land]) disneyland[data.land] = [];
        disneyland[data.land].push(data);
      } else if (data.locationName?.includes('California Adventure')) {
        if (!californiaAdventure[data.land]) californiaAdventure[data.land] = [];
        californiaAdventure[data.land].push(data);
      } else if (data.locationName?.includes('Downtown Disney')) {
        // Add Downtown Disney as separate category
        if (!disneyland['Downtown Disney']) disneyland['Downtown Disney'] = [];
        disneyland['Downtown Disney'].push(data);
      }
    });

    // Sort alphabetically within each land
    this.sortRestaurants(disneyland);
    this.sortRestaurants(californiaAdventure);

    return { disneyland, californiaAdventure };
  }

  extractLandFromLocation(locationName) {
    if (!locationName) return 'Other';
    
    // Map of location strings to land names
    const landMap = {
      'Main Street': 'Main Street U.S.A.',
      'Adventureland': 'Adventureland',
      'Frontierland': 'Frontierland',
      'New Orleans Square': 'New Orleans Square',
      'Critter Country': 'Critter Country',
      'Star Wars': 'Star Wars: Galaxy\'s Edge',
      'Fantasyland': 'Fantasyland',
      'Toontown': 'Mickey\'s Toontown',
      'Tomorrowland': 'Tomorrowland',
      
      'Buena Vista': 'Buena Vista Street',
      'Hollywood Land': 'Hollywood Land',
      'Avengers Campus': 'Avengers Campus',
      'Cars Land': 'Cars Land',
      'Grizzly Peak': 'Grizzly Peak',
      'Pixar Pier': 'Pixar Pier',
      'Paradise': 'Paradise Gardens',
      
      'Downtown Disney': 'Downtown Disney'
    };
    
    for (const [key, value] of Object.entries(landMap)) {
      if (locationName.includes(key)) return value;
    }
    
    return 'Other';
  }

  extractPriceRange(priceRangeArray) {
    if (!priceRangeArray || priceRangeArray.length === 0) return null;
    return priceRangeArray[0]; // Returns "$", "$$", "$$$", or "$$$$"
  }

  extractHours(schedule, date) {
    if (!schedule || !schedule.schedules) return 'Hours vary';
    
    // Find schedule for the requested date
    const daySchedule = schedule.schedules.find(s => s.date === date);
    
    if (!daySchedule) return 'Check Disney app';
    if (daySchedule.isClosed) return 'Closed';
    
    return `${this.formatTime(daySchedule.startTime)} - ${this.formatTime(daySchedule.endTime)}`;
  }

  checkIfClosed(schedule, date) {
    if (!schedule || !schedule.schedules) return false;
    const daySchedule = schedule.schedules.find(s => s.date === date);
    return daySchedule?.isClosed || false;
  }

  formatTime(timeString) {
    // Convert "08:00:00" to "8:00 AM"
    if (!timeString) return '';
    const [hours, minutes] = timeString.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
    return `${displayHour}:${minutes} ${ampm}`;
  }

  hasMobileOrder(facets) {
    return facets.mobileOrder?.length > 0 || false;
  }

  acceptsReservations(restaurant) {
    const serviceType = restaurant.facetGroupType || '';
    return serviceType.includes('Table Service');
  }

  getStatus(restaurant) {
    // You can enhance this based on schedule or other fields
    return 'OPERATING';
  }

  sortRestaurants(parkData) {
    Object.keys(parkData).forEach(land => {
      parkData[land].sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  getTodayDate() {
    const today = new Date();
    return today.toISOString().split('T')[0];
  }

  async saveToFile() {
    try {
      const data = {
        cache: this.cache,
        lastUpdate: this.lastUpdate
      };
      await fs.writeFile('./dining-data-cache.json', JSON.stringify(data, null, 2));
      console.log('💾 Dining data saved to cache file');
    } catch (error) {
      console.error('Error saving dining data:', error);
    }
  }

  async loadFromCache() {
    try {
      const fileData = await fs.readFile('./dining-data-cache.json', 'utf8');
      const data = JSON.parse(fileData);
      this.cache = data.cache;
      this.lastUpdate = new Date(data.lastUpdate);
      console.log('📂 Loaded dining data from cache file');
      return this.cache;
    } catch (error) {
      console.log('No cache file found, returning empty data');
      return { disneyland: {}, californiaAdventure: {} };
    }
  }

  getCachedData() {
    return this.cache;
  }

  isCacheStale() {
    if (!this.lastUpdate) return true;
    const hoursSinceUpdate = (Date.now() - this.lastUpdate.getTime()) / (1000 * 60 * 60);
    return hoursSinceUpdate >= 24;
  }
}

module.exports = new SimplifiedDiningService();

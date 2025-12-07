// puppeteerDiningScraper.js
const puppeteer = require('puppeteer');
const fs = require('fs').promises;

class SimplifiedPuppeteerScraper {
  constructor() {
    this.cache = {
      disneyland: {},
      californiaAdventure: {}
    };
    this.lastScrape = null;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async scrapeDiningData() {
    console.log('🎭 Starting Puppeteer dining scraper...');
    
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });

      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });

      console.log('📄 Loading Disney dining page...');
      
      // Capture API responses
      let diningData = null;
      
      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('finder/api') && url.includes('dining') && url.includes('list-ancestor-entities')) {
          try {
            const data = await response.json();
            if (data.results && Array.isArray(data.results)) {
              diningData = data.results;
              console.log(`✅ Captured dining API with ${data.results.length} restaurants`);
            }
          } catch (e) {
            // Not JSON, skip
          }
        }
      });

      await page.goto('https://disneyland.disney.go.com/dining/', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      // Wait for API call to complete
      await this.sleep(3000);

      if (!diningData || diningData.length === 0) {
        throw new Error('No dining data captured from API');
      }

      console.log(`🍽️  Processing ${diningData.length} restaurants...`);

      // Process the data
      this.cache = this.organizeRestaurants(diningData);
      this.lastScrape = new Date();

      await browser.close();
      
      // Save to file
      await this.saveToFile();

      console.log('✅ Dining data scraping complete!');
      console.log(`   - Disneyland: ${Object.values(this.cache.disneyland).flat().length} restaurants`);
      console.log(`   - DCA: ${Object.values(this.cache.californiaAdventure).flat().length} restaurants`);
      
      return this.cache;

    } catch (error) {
      console.error('❌ Puppeteer scraping error:', error.message);
      if (browser) await browser.close();
      
      // Load from file if available
      return await this.loadFromFile();
    }
  }

  organizeRestaurants(restaurants) {
    const disneyland = {};
    const californiaAdventure = {};
    const today = this.getTodayDate();

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
        hours: this.extractHours(restaurant.schedule, today),
        isClosed: this.checkIfClosed(restaurant.schedule, today),
        
        // Links
        menuLink: restaurant.webLinks?.dlrDetails?.href
          ? `https://disneyland.disney.go.com${restaurant.webLinks.dlrDetails.href}`
          : restaurant.url
          ? `https://disneyland.disney.go.com${restaurant.url}`
          : null,
        
        // Features
        mobileOrder: this.hasMobileOrder(restaurant.facets || {}),
        acceptsReservations: this.acceptsReservations(restaurant),
        
        // Status
        status: 'OPERATING'
      };

      // Organize by park
      if (data.locationName?.includes('Disneyland Park')) {
        if (!disneyland[data.land]) disneyland[data.land] = [];
        disneyland[data.land].push(data);
      } else if (data.locationName?.includes('California Adventure')) {
        if (!californiaAdventure[data.land]) californiaAdventure[data.land] = [];
        californiaAdventure[data.land].push(data);
      } else if (data.locationName?.includes('Downtown Disney')) {
        if (!disneyland['Downtown Disney']) disneyland['Downtown Disney'] = [];
        disneyland['Downtown Disney'].push(data);
      }
    });

    // Sort alphabetically
    this.sortRestaurants(disneyland);
    this.sortRestaurants(californiaAdventure);

    return { disneyland, californiaAdventure };
  }

  extractLandFromLocation(locationName) {
    if (!locationName) return 'Other';
    
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
    return priceRangeArray[0];
  }

  extractHours(schedule, date) {
    if (!schedule || !schedule.schedules) return 'Hours vary';
    
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
        lastScrape: this.lastScrape
      };
      await fs.writeFile('./dining-data-cache.json', JSON.stringify(data, null, 2));
      console.log('💾 Dining data saved to cache file');
    } catch (error) {
      console.error('Error saving dining data:', error);
    }
  }

  async loadFromFile() {
    try {
      const fileData = await fs.readFile('./dining-data-cache.json', 'utf8');
      const data = JSON.parse(fileData);
      this.cache = data.cache;
      this.lastScrape = new Date(data.lastScrape);
      console.log('📂 Loaded dining data from cache file');
      return this.cache;
    } catch (error) {
      console.log('📂 No cache file found');
      return { disneyland: {}, californiaAdventure: {} };
    }
  }

  getCachedData() {
    return this.cache;
  }

  shouldScrape() {
    if (!this.lastScrape) return true;
    const hoursSinceScrape = (Date.now() - this.lastScrape.getTime()) / (1000 * 60 * 60);
    return hoursSinceScrape >= 24;
  }
}

module.exports = new SimplifiedPuppeteerScraper();

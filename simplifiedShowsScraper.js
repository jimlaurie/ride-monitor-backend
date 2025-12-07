// simplifiedShowsScraper.js
const puppeteer = require('puppeteer');
const fs = require('fs').promises;

class SimplifiedShowsScraper {
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

  async scrapeShowsData() {
    console.log('🎭 Starting Puppeteer shows scraper...');
    
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-http2'
        ]
      });

      const page = await browser.newPage();
      
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      console.log('📄 Loading Disney entertainment page...');
      
      // Capture API responses
      let showsData = null;
      
      page.on('response', async (response) => {
        const url = response.url();
        // Look for entertainment/shows API endpoint
        if (url.includes('finder/api') && url.includes('entertainment')) {
          try {
            const data = await response.json();
            if (data.results && Array.isArray(data.results)) {
              showsData = data.results;
              console.log(`✅ Captured shows API with ${data.results.length} shows`);
            }
          } catch (e) {
            // Not JSON or error parsing, skip
          }
        }
      });

      // Navigate to entertainment page
      await page.goto('https://disneyland.disney.go.com/entertainment/', {
        waitUntil: 'networkidle0',
        timeout: 45000
      });

      // Wait for API calls to complete
      await this.sleep(5000);

      await browser.close();

      if (!showsData || showsData.length === 0) {
        console.log('⚠️  No shows data captured, loading from cache...');
        return await this.loadFromFile();
      }

      console.log(`🎭 Processing ${showsData.length} shows...`);

      // Process the data
      this.cache = this.organizeShows(showsData);
      this.lastScrape = new Date();

      // Save to file
      await this.saveToFile();

      console.log('✅ Shows data scraping complete!');
      console.log(`   - Disneyland: ${Object.values(this.cache.disneyland).flat().length} shows`);
      console.log(`   - DCA: ${Object.values(this.cache.californiaAdventure).flat().length} shows`);
      
      return this.cache;

    } catch (error) {
      console.error('❌ Puppeteer shows scraping error:', error.message);
      if (browser) {
        try {
          await browser.close();
        } catch (e) {
          // Ignore close error
        }
      }
      
      // Load from file if available
      return await this.loadFromFile();
    }
  }

  organizeShows(shows) {
    const disneyland = {};
    const californiaAdventure = {};
    const today = this.getTodayDate();

    shows.forEach(show => {
      // Extract the data we want
      const data = {
        id: show.facilityId || show.id,
        name: show.name,
        
        // Location
        locationName: show.locationName,
        land: this.extractLandFromLocation(show.locationName),
        coordinates: show.marker ? {
          lat: show.marker.lat,
          lng: show.marker.lng
        } : null,
        
        // Show details
        showType: show.facetGroupType || 'Entertainment',
        entertainmentType: show.type?.facets || '',
        duration: this.extractDuration(show),
        
        // Schedule
        showtimes: this.extractShowtimes(show.schedule, today),
        isClosed: this.checkIfClosed(show.schedule, today),
        
        // Links
        showLink: this.buildShowLink(show),
        
        // Additional info
        description: show.descriptions?.short || show.descriptions?.long || '',
        
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
      }
    });

    // Sort alphabetically
    this.sortShows(disneyland);
    this.sortShows(californiaAdventure);

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
      
      'Rivers of America': 'Frontierland',
      'Central Plaza': 'Main Street U.S.A.'
    };
    
    for (const [key, value] of Object.entries(landMap)) {
      if (locationName.includes(key)) return value;
    }
    
    return 'Other';
  }

  extractDuration(show) {
    // Try to extract duration from various fields
    if (show.duration) return show.duration;
    if (show.descriptions?.long) {
      const match = show.descriptions.long.match(/(\d+)\s*(minute|min)/i);
      if (match) return `${match[1]} minutes`;
    }
    return null;
  }

  extractShowtimes(schedule, date) {
    if (!schedule || !schedule.schedules) return [];
    
    const showtimes = [];
    
    schedule.schedules.forEach(daySchedule => {
      // If date matches or no specific date filtering
      if (!date || daySchedule.date === date) {
        showtimes.push({
          date: daySchedule.date,
          startTime: this.formatTime(daySchedule.startTime),
          endTime: this.formatTime(daySchedule.endTime),
          rawStartTime: daySchedule.startTime,
          rawEndTime: daySchedule.endTime,
          isClosed: daySchedule.isClosed || false
        });
      }
    });
    
    return showtimes;
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

  buildShowLink(show) {
    // Check webLinks first
    if (show.webLinks?.dlrDetails?.href) {
      const href = show.webLinks.dlrDetails.href;
      if (href.startsWith('http')) return href;
      return `https://disneyland.disney.go.com${href}`;
    }
    
    // Fallback to url property
    if (show.url) {
      const url = show.url;
      if (url.startsWith('http')) return url;
      return `https://disneyland.disney.go.com${url}`;
    }
    
    return null;
  }

  sortShows(parkData) {
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
      await fs.writeFile('./shows-data-cache.json', JSON.stringify(data, null, 2));
      console.log('💾 Shows data saved to cache file');
    } catch (error) {
      console.error('Error saving shows data:', error);
    }
  }

  async loadFromFile() {
    try {
      const fileData = await fs.readFile('./shows-data-cache.json', 'utf8');
      const data = JSON.parse(fileData);
      this.cache = data.cache;
      this.lastScrape = new Date(data.lastScrape);
      console.log('📂 Loaded shows data from cache file');
      return this.cache;
    } catch (error) {
      console.log('📂 No shows cache file found, will return empty data');
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

module.exports = new SimplifiedShowsScraper();

// puppeteerDiningScraper.js
const puppeteer = require('puppeteer');
const fs = require('fs').promises;

class PuppeteerDiningScraper {
  constructor() {
    this.enhancedData = {
      disneyland: {},
      californiaAdventure: {}
    };
    this.lastScrape = null;
  }
    
    // ADD THIS HELPER FUNCTION
    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
    
  async scrapeEnhancedDiningData() {
    console.log('🎭 Starting Puppeteer dining scraper...');
    
    let browser;
    try {
      browser = await puppeteer.launch({
          headless: true,
                  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // Use your Mac's Chrome
                  args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                  ]
      });

      const page = await browser.newPage();
      
      // Set viewport and user agent
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      console.log('📄 Loading Disney dining page...');
      
      // Intercept API responses
      const apiResponses = [];
      
      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('finder/api') && url.includes('dining')) {
          try {
            const data = await response.json();
            apiResponses.push(data);
            console.log(`✅ Captured API response: ${url}`);
          } catch (e) {
            // Not JSON, skip
          }
        }
      });

      // Navigate to dining page
      await page.goto('https://disneyland.disney.go.com/dining/', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      // Wait a bit for all API calls to complete
//      await page.waitForTimeout(5000);
        await this.sleep(5000);
      console.log(`📊 Captured ${apiResponses.length} API responses`);

      // Extract data from responses
      let allRestaurants = [];
      apiResponses.forEach(response => {
        if (response.results && Array.isArray(response.results)) {
          allRestaurants = allRestaurants.concat(response.results);
        }
      });

      console.log(`🍽️  Found ${allRestaurants.length} restaurants`);

      // Now scrape individual restaurant pages for menu/pricing
      const enhancedRestaurants = await this.scrapeRestaurantDetails(page, allRestaurants.slice(0, 20)); // Test with first 20

      await browser.close();
      
      // Organize data
      this.enhancedData = this.organizeEnhancedData(enhancedRestaurants);
      this.lastScrape = new Date();

      // Save to file for persistence
      await this.saveToFile();

      console.log('✅ Puppeteer scraping complete!');
      return this.enhancedData;

    } catch (error) {
      console.error('❌ Puppeteer scraping error:', error.message);
      if (browser) await browser.close();
      
      // Try to load from file
      return await this.loadFromFile();
    }
  }

  async scrapeRestaurantDetails(page, restaurants) {
    console.log(`🔍 Scraping detailed info for ${restaurants.length} restaurants...`);
    
    const enhanced = [];
    
    for (const restaurant of restaurants) {
      try {
        const url = `https://disneyland.disney.go.com${restaurant.url}`;
        console.log(`  → ${restaurant.name}...`);
        
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
//        await page.waitForTimeout(2000);
          await this.sleep(2000);
          // Extract menu and pricing data
                  const details = await page.evaluate(() => {
                    const menuItems = [];
                    
                    // Try multiple selectors for menu items
                    const menuSelectors = [
                      '.menu-item',
                      '[class*="menu"]',
                      '[data-name*="menu"]',
                      '.dining-item'
                    ];
                    
                    let menuElements = [];
                    for (const selector of menuSelectors) {
                      menuElements = Array.from(document.querySelectorAll(selector));
                      if (menuElements.length > 0) break;
                    }
                    
                    menuElements.forEach(item => {
                      const name = item.querySelector('[class*="name"]')?.textContent?.trim() ||
                                  item.querySelector('h3')?.textContent?.trim() ||
                                  item.querySelector('h4')?.textContent?.trim();
                      
                      const price = item.querySelector('[class*="price"]')?.textContent?.trim() ||
                                   item.textContent.match(/\$\d+(\.\d{2})?/)?.[0];
                      
                      const description = item.querySelector('[class*="description"]')?.textContent?.trim() ||
                                         item.querySelector('p')?.textContent?.trim();
                      
                      if (name) {
                        menuItems.push({ name, price, description });
                      }
                    });

                    // Extract price range - look for $ symbols
                    let priceRange = null;
                    const priceElements = document.body.innerText;
                    if (priceElements.includes('$$$$')) priceRange = '$$$$';
                    else if (priceElements.includes('$$$')) priceRange = '$$$';
                    else if (priceElements.includes('$$')) priceRange = '$$';
                    else if (priceElements.includes('$')) priceRange = '$';
                    
                    // Extract dining tags
                    const tags = [];
                    document.querySelectorAll('[class*="tag"], [class*="badge"]').forEach(el => {
                      const text = el.textContent.trim();
                      if (text) tags.push(text);
                    });

                    return {
                      menuItems,
                      priceRange,
                      tags,
                      pageText: document.body.innerText.substring(0, 500) // Debug: get sample text
                    };
                  });
          
        enhanced.push({
          ...restaurant,
          menuItems: details.menuItems,
          priceRange: details.priceRange || this.inferPriceRange(details.menuItems),
          tags: details.tags
        });
          
          // ADD THIS DEBUG LOG
           console.log(`    Found: ${details.menuItems.length} menu items, price: ${details.priceRange || 'none'}`);
          
      } catch (error) {
        console.log(`    ⚠️  Error scraping ${restaurant.name}: ${error.message}`);
        enhanced.push(restaurant); // Add without enhancement
      }
    }

    return enhanced;
  }

  inferPriceRange(menuItems) {
    if (!menuItems || menuItems.length === 0) return null;
    
    const prices = menuItems
      .map(item => parseFloat(item.price?.replace(/[^0-9.]/g, '')))
      .filter(p => !isNaN(p));
    
    if (prices.length === 0) return null;
    
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    
    if (avgPrice < 15) return '$';
    if (avgPrice < 30) return '$$';
    if (avgPrice < 60) return '$$$';
    return '$$$$';
  }

  organizeEnhancedData(restaurants) {
    const disneyland = {};
    const californiaAdventure = {};

    restaurants.forEach(restaurant => {
      const parkName = restaurant.locationName;
      const landName = 'Other'; // We'll enhance this with your mappings
      
      const data = {
        id: restaurant.facilityId,
        name: restaurant.name,
        type: restaurant.facetGroupType,
        priceRange: restaurant.priceRange,
        menuItems: restaurant.menuItems || [],
        tags: restaurant.tags || [],
        url: restaurant.url,
        enhanced: true,
        scrapedAt: new Date().toISOString()
      };

      if (parkName?.includes('Disneyland Park')) {
        if (!disneyland[landName]) disneyland[landName] = [];
        disneyland[landName].push(data);
      } else if (parkName?.includes('California Adventure')) {
        if (!californiaAdventure[landName]) californiaAdventure[landName] = [];
        californiaAdventure[landName].push(data);
      }
    });

    return { disneyland, californiaAdventure };
  }

  async saveToFile() {
    try {
      const data = {
        enhancedData: this.enhancedData,
        lastScrape: this.lastScrape
      };
      await fs.writeFile('./enhanced-dining-data.json', JSON.stringify(data, null, 2));
      console.log('💾 Enhanced data saved to file');
    } catch (error) {
      console.error('Error saving enhanced data:', error);
    }
  }

  async loadFromFile() {
    try {
      const fileData = await fs.readFile('./enhanced-dining-data.json', 'utf8');
      const data = JSON.parse(fileData);
      this.enhancedData = data.enhancedData;
      this.lastScrape = new Date(data.lastScrape);
      console.log('📂 Loaded enhanced data from file');
      return this.enhancedData;
    } catch (error) {
      console.log('No enhanced data file found, will scrape fresh');
      return { disneyland: {}, californiaAdventure: {} };
    }
  }

  getEnhancedData() {
    return this.enhancedData;
  }

  shouldScrape() {
    if (!this.lastScrape) return true;
    const daysSinceScrape = (Date.now() - this.lastScrape.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceScrape >= 7; // Scrape weekly
  }
}

module.exports = new PuppeteerDiningScraper();

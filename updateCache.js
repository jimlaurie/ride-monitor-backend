// updateCache.js - Run this locally to update cache files
// Can be automated with cron or launchd on Mac

const diningService = require('./simplifiedDiningScraper');
const showsService = require('./simplifiedShowsScraper');
const { execSync } = require('child_process');

async function updateAllCaches() {
  console.log('🔄 Starting cache update process...');
  console.log('═══════════════════════════════════════════\n');
  
  try {
    // Update dining data
    console.log('📍 Step 1: Updating Dining Data');
    await diningService.scrapeDiningData();
    console.log('✅ Dining data updated!\n');
    
    // Update shows data
    console.log('📍 Step 2: Updating Shows Data');
    await showsService.scrapeShowsData();
    console.log('✅ Shows data updated!\n');
    
    // Git commit and push
    console.log('📍 Step 3: Committing to Git');
    
    try {
      // Check if there are changes
      execSync('git diff --quiet dining-data-cache.json shows-data-cache.json', { stdio: 'ignore' });
      console.log('ℹ️  No changes detected in cache files');
    } catch (error) {
      // There are changes, commit them
      console.log('📝 Changes detected, committing...');
      
      execSync('git add dining-data-cache.json shows-data-cache.json');
      
      const timestamp = new Date().toLocaleString();
      execSync(`git commit -m "Auto-update cache files - ${timestamp}"`);
      
      console.log('⬆️  Pushing to GitHub...');
      execSync('git push origin main');
      
      console.log('✅ Changes pushed to GitHub!\n');
    }
    
    console.log('═══════════════════════════════════════════');
    console.log('🎉 Cache update complete!');
    console.log('   Heroku will deploy automatically from GitHub');
    console.log('═══════════════════════════════════════════\n');
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error during cache update:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the update
updateAllCaches();

/**
 * Test script for Ride Wait Monitor Backend API
 * Run with: node test-api.js
 */

const axios = require('axios');

// Change this to your backend URL
const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testEndpoint(name, method, url, data = null) {
  try {
    log(`\n🧪 Testing: ${name}`, 'cyan');
    log(`   ${method} ${url}`, 'yellow');
    
    let response;
    if (method === 'GET') {
      response = await axios.get(url);
    } else if (method === 'POST') {
      response = await axios.post(url, data);
    }
    
    log(`   ✓ Status: ${response.status}`, 'green');
    
    if (response.data) {
      const dataStr = JSON.stringify(response.data, null, 2);
      const preview = dataStr.length > 200 
        ? dataStr.substring(0, 200) + '...' 
        : dataStr;
      log(`   Response: ${preview}`, 'reset');
    }
    
    return { success: true, data: response.data };
  } catch (error) {
    log(`   ✗ Error: ${error.message}`, 'red');
    if (error.response) {
      log(`   Status: ${error.response.status}`, 'red');
      log(`   Data: ${JSON.stringify(error.response.data)}`, 'red');
    }
    return { success: false, error: error.message };
  }
}

async function runTests() {
  log('\n========================================', 'cyan');
  log('  Ride Wait Monitor API Tests', 'cyan');
  log('========================================\n', 'cyan');
  log(`Testing API at: ${API_BASE_URL}\n`);

  const testUserId = `test_user_${Date.now()}`;
  const results = {
    passed: 0,
    failed: 0,
    total: 0
  };

  // Test 1: Health Check
  results.total++;
  const health = await testEndpoint(
    'Health Check',
    'GET',
    `${API_BASE_URL}/health`
  );
  if (health.success) results.passed++;
  else results.failed++;

  // Test 2: Get Parks
  results.total++;
  const parks = await testEndpoint(
    'Get Parks List',
    'GET',
    `${API_BASE_URL}/api/parks`
  );
  if (parks.success) results.passed++;
  else results.failed++;

  // Test 3: Get Disneyland Wait Times
  results.total++;
  const disneylandWaitTimes = await testEndpoint(
    'Get Disneyland Wait Times',
    'GET',
    `${API_BASE_URL}/api/parks/disneyland/wait-times`
  );
  if (disneylandWaitTimes.success) {
    results.passed++;
    
    // Display some stats
    if (disneylandWaitTimes.data.lands) {
      log(`\n   📊 Stats:`, 'cyan');
      const landCount = Object.keys(disneylandWaitTimes.data.lands).length;
      const rideCount = disneylandWaitTimes.data.rides?.length || 0;
      log(`      - Lands: ${landCount}`, 'reset');
      log(`      - Rides: ${rideCount}`, 'reset');
      
      if (disneylandWaitTimes.data.rides && disneylandWaitTimes.data.rides.length > 0) {
        const operating = disneylandWaitTimes.data.rides.filter(r => r.status === 'OPERATING').length;
        const closed = disneylandWaitTimes.data.rides.filter(r => r.status === 'DOWN').length;
        log(`      - Operating: ${operating}`, 'green');
        log(`      - Closed: ${closed}`, 'red');
        
        // Show a sample ride
        const sampleRide = disneylandWaitTimes.data.rides[0];
        log(`\n   📝 Sample Ride:`, 'cyan');
        log(`      ${sampleRide.name}`, 'yellow');
        log(`      Wait: ${sampleRide.currentWait} min`, 'reset');
        log(`      Status: ${sampleRide.status}`, 'reset');
        log(`      Land: ${sampleRide.land}`, 'reset');
      }
    }
  } else {
    results.failed++;
  }

  // Test 4: Get California Adventure Wait Times
  results.total++;
  const dcaWaitTimes = await testEndpoint(
    'Get California Adventure Wait Times',
    'GET',
    `${API_BASE_URL}/api/parks/californiaadventure/wait-times`
  );
  if (dcaWaitTimes.success) results.passed++;
  else results.failed++;

  // Test 5: Save User Preferences
  results.total++;
  const savePrefs = await testEndpoint(
    'Save User Preferences',
    'POST',
    `${API_BASE_URL}/api/users/${testUserId}/preferences`,
    {
      preferences: {
        'ride_1': { enabled: true, maxWait: 30 },
        'ride_2': { enabled: true, maxWait: 45 }
      }
    }
  );
  if (savePrefs.success) results.passed++;
  else results.failed++;

  // Test 6: Get User Preferences
  results.total++;
  const getPrefs = await testEndpoint(
    'Get User Preferences',
    'GET',
    `${API_BASE_URL}/api/users/${testUserId}/preferences`
  );
  if (getPrefs.success) results.passed++;
  else results.failed++;

  // Test 7: Get Ready Rides
  results.total++;
  const readyRides = await testEndpoint(
    'Get Ready Rides for User',
    'GET',
    `${API_BASE_URL}/api/users/${testUserId}/ready-rides`
  );
  if (readyRides.success) {
    results.passed++;
    if (readyRides.data.readyRides) {
      log(`\n   🎢 Ready Rides: ${readyRides.data.readyRides.length}`, 'cyan');
    }
  } else {
    results.failed++;
  }

  // Test 8: Manual Refresh
  results.total++;
  log(`\n⏳ Triggering manual refresh (this may take 10-20 seconds)...`, 'yellow');
  const refresh = await testEndpoint(
    'Manual Refresh',
    'POST',
    `${API_BASE_URL}/api/refresh`
  );
  if (refresh.success) results.passed++;
  else results.failed++;

  // Summary
  log('\n========================================', 'cyan');
  log('  Test Summary', 'cyan');
  log('========================================\n', 'cyan');
  log(`Total Tests: ${results.total}`, 'reset');
  log(`Passed: ${results.passed}`, 'green');
  log(`Failed: ${results.failed}`, results.failed > 0 ? 'red' : 'green');
  log(`Success Rate: ${Math.round((results.passed / results.total) * 100)}%\n`, 
      results.failed === 0 ? 'green' : 'yellow');

  if (results.failed === 0) {
    log('✅ All tests passed! Your API is working correctly.', 'green');
  } else {
    log('⚠️  Some tests failed. Check the errors above.', 'yellow');
  }

  // Performance check
  if (health.success && health.data.cacheStatus) {
    log('\n📅 Cache Status:', 'cyan');
    Object.entries(health.data.cacheStatus).forEach(([park, lastUpdate]) => {
      if (lastUpdate) {
        const updateTime = new Date(lastUpdate);
        const minutesAgo = Math.round((Date.now() - updateTime.getTime()) / 60000);
        log(`   ${park}: ${minutesAgo} minutes ago`, 'reset');
      } else {
        log(`   ${park}: Not yet cached`, 'yellow');
      }
    });
  }

  log('\n');
}

// Run tests
log('\nStarting API tests...\n');
runTests().then(() => {
  process.exit(0);
}).catch(error => {
  log(`\n❌ Test suite failed: ${error.message}`, 'red');
  process.exit(1);
});
const admin = require('firebase-admin');

admin.initializeApp();

// Mate-ping alerts (functions/pings.js)
Object.assign(exports, require('./pings'));

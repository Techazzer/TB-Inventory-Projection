const fs = require('fs');
const cache = require('./backend_cache.json');
const lines = cache.txnCSV.split('\n');
console.log(lines[0]);
console.log(lines[1]);

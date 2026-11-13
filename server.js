'use strict';
// Runs the addon on this computer:  node server.js  ->  http://127.0.0.1:7711/manifest.json
const http = require('http');
const { handle } = require('./lib/addon');

const port = +process.env.PORT || 7711;
const host = process.env.HOST || '127.0.0.1';
http.createServer(handle).listen(port, host, () => {
  console.log(`Greek AutoSync running: http://${host}:${port}/manifest.json`);
});

'use strict';
// Vercel entry point: every request goes to the same handler the local server uses.
const { handle } = require('../lib/addon');
module.exports = (req, res) => handle(req, res);

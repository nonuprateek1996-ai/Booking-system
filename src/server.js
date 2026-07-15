'use strict';

const app = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`Booking system listening on http://${HOST}:${PORT}`);
});

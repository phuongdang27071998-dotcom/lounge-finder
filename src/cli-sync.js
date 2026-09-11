import { syncAirport } from './scraper.js';
const code=process.argv[2]; if(!code){console.error('Usage: npm run sync:airport -- DOH');process.exit(1)}
console.log(await syncAirport(code));

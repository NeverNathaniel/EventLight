// Import this FIRST in any test that touches the database: static imports are
// evaluated before the test file's own code, so setting EVENTLIGHT_DB inside a
// test is too late once src/config.js has loaded — the real data/events.db
// would be used.
process.env.EVENTLIGHT_DB = ':memory:';

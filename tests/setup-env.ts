// Runs in each test worker before test files are imported. DATABASE_URL is
// inherited from global-setup; guard against ever pointing tests at a remote DB.
const url = process.env.DATABASE_URL ?? '';
if (!/@localhost:\d+\/carevanta_test$/.test(url)) {
  throw new Error('Refusing to run tests: DATABASE_URL is not the local embedded test database');
}

// Runs in each test worker before test files are imported. MONGODB_URI is
// inherited from global-setup; guard against ever pointing tests at a remote DB.
const url = process.env.MONGODB_URI ?? '';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/carevanta_test(\?|$)/.test(url)) {
  throw new Error('Refusing to run tests: MONGODB_URI is not the local in-memory test database');
}

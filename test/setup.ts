// TEST_DATABASE_URL may live in .env; database tests are skipped when it isn't set
import "dotenv/config";

// Dates in assertions are formatted in UTC
process.env.TZ = "UTC";

import { generateApiKey } from "./api-key.js";
import dotenv from "dotenv";
dotenv.config();

const args = process.argv.slice(2);

let secret: string | undefined;
let label: string | undefined;

if (args.length === 2) {
  // npm run generate-key -- <API_SECRET> <label>
  secret = args[0];
  label = args[1];
} else if (args.length === 1 && process.env.API_SECRET) {
  // npm run generate-key -- <label>  (secret from .env)
  secret = process.env.API_SECRET;
  label = args[0];
} else {
  console.error("Usage: npm run generate-key -- <API_SECRET> <label>");
  console.error("       npm run generate-key -- <label>          (uses API_SECRET from .env)");
  console.error("Example: npm run generate-key -- my-secret-value admin");
  process.exit(1);
}

if (!secret || !label) {
  console.error("Error: Both secret and label are required.");
  process.exit(1);
}

const key = generateApiKey(label, secret);
console.log(`\nGenerated API key for label "${label}":\n`);
console.log(`  ${key}\n`);
console.log("Use via header:");
console.log(`  Authorization: Bearer ${key}`);
console.log(`  X-API-Key: ${key}\n`);
console.error("Store this key securely. It will not be shown again.");

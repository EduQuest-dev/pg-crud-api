import { generateApiKey, parsePermissionsString, SchemaPermissions } from "./api-key.js";
import dotenv from "dotenv";
dotenv.config();

const args = process.argv.slice(2);

let secret: string | undefined;
let label: string | undefined;
let permissions: SchemaPermissions | undefined;

// Parse --schemas flag from args
const schemasIdx = args.indexOf("--schemas");
if (schemasIdx !== -1) {
  const schemasValue = args[schemasIdx + 1];
  if (!schemasValue) {
    console.error("Error: --schemas requires a value (e.g., --schemas public:rw,reporting:r)");
    process.exit(1);
  }
  try {
    permissions = parsePermissionsString(schemasValue);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
  // Remove --schemas and its value from args
  args.splice(schemasIdx, 2);
}

if (args.length === 2) {
  // npm run generate-key -- <API_SECRET> <label>
  secret = args[0];
  label = args[1];
} else if (args.length === 1 && process.env.API_SECRET) {
  // npm run generate-key -- <label>  (secret from .env)
  secret = process.env.API_SECRET;
  label = args[0];
} else {
  console.error("Usage: npm run generate-key -- <API_SECRET> <label> [--schemas schema:perm,...]");
  console.error("       npm run generate-key -- <label> [--schemas schema:perm,...]  (uses API_SECRET from .env)");
  console.error("\nExamples:");
  console.error("  npm run generate-key -- my-secret admin");
  console.error("  npm run generate-key -- my-secret reader --schemas public:r");
  console.error("  npm run generate-key -- my-secret service --schemas public:rw,reporting:r");
  console.error("  npm run generate-key -- my-secret full-access --schemas '*:rw'");
  console.error("\nPermission values: r (read), w (write), rw (read+write)");
  console.error("Use * as schema name for wildcard (all schemas).");
  process.exit(1);
}

if (!secret || !label) {
  console.error("Error: Both secret and label are required.");
  process.exit(1);
}

const key = generateApiKey(label, secret, permissions);
console.log(`\nGenerated API key for label "${label}":\n`);
console.log(`  ${key}\n`);
if (permissions) {
  console.log("Schema permissions:");
  for (const [schema, perm] of Object.entries(permissions)) {
    const permDesc = perm === "rw" ? "read+write" : perm === "r" ? "read-only" : "write-only";
    console.log(`  ${schema}: ${permDesc}`);
  }
  console.log();
}
console.log("Use via header:");
console.log(`  Authorization: Bearer ${key}`);
console.log(`  X-API-Key: ${key}\n`);
console.error("Store this key securely. It will not be shown again.");

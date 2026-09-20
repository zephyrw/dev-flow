import { openBrowser } from "./launcher.js";
const isAccounts = process.argv.includes("--accounts");
await openBrowser(isAccounts ? "accounts" : "full");

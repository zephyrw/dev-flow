import { openBrowser } from "./launcher.js";
const isAccounts = process.argv.includes("--accounts");
const result = await openBrowser(isAccounts ? "accounts" : "full");
console.log(result.message);
if (!result.opened) {
  console.log(result.url);
  process.exitCode = 0;
}

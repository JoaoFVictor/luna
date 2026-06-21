import { main } from "./core/agent-runtime/flue/cli.js";

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
}
